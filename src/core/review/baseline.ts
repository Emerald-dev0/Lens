/**
 * Baseline management for visual regression.
 *
 * A baseline is a named, committed-by-choice reference image with the metadata
 * needed to explain it: which viewport, which URL, which review verdict was current
 * when it was captured. That context is what makes "accept the change" a decision
 * instead of a reflex.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ResolvedConfig } from '../config/load.js';
import { ArtifactStore } from '../artifacts/paths.js';
import { compareImages, type CompareOptions, type CompareResult } from '../capture/diff.js';
import { ensureDir, readJsonOpt, removeTree, safeName, sha256File, writeJson } from '../util/fs.js';
import { LensError, LensErrorCode } from '../errors.js';

export interface BaselineMeta {
  name: string;
  image: string;
  createdAt: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  url?: string;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  label?: string;
  notes?: string;
  /** Deliberately recorded so `lens compare` can say how old the reference is. */
  lensVersion?: string;
}

export interface BaselineSummary extends BaselineMeta {
  ageDays: number;
  missing: boolean;
}

export interface BaselineUpdateResult {
  name: string;
  path: string;
  meta: BaselineMeta;
  replaced: boolean;
}

export interface BaselineCompareResult {
  name: string;
  verdict: 'match' | 'changed' | 'missing-baseline';
  baseline: BaselineMeta | null;
  comparison: CompareResult | null;
  suggestion: string;
}

export class BaselineService {
  private readonly store: ArtifactStore;

  constructor(config: ResolvedConfig) {
    this.store = new ArtifactStore(config);
  }

  dir(name: string): string {
    return this.store.baselineDir(safeName(name, 'default'));
  }

  imagePath(name: string): string {
    return path.join(this.dir(name), 'baseline.png');
  }

  metaPath(name: string): string {
    return path.join(this.dir(name), 'meta.json');
  }

  diffPath(name: string): string {
    return path.join(this.dir(name), 'latest-diff.png');
  }

  async update(name: string, screenshotPath: string, extra: Partial<BaselineMeta> = {}): Promise<BaselineUpdateResult> {
    if (!fs.existsSync(screenshotPath)) {
      throw new LensError({
        code: LensErrorCode.FILE_NOT_FOUND,
        message: `The screenshot to promote to a baseline does not exist: ${screenshotPath}`,
        scope: 'input',
        hints: ['Capture one first: `lens screenshot --label homepage` then `lens compare --update-baseline homepage`.'],
      });
    }
    const target = this.imagePath(name);
    await ensureDir(path.dirname(target));
    const replaced = fs.existsSync(target);
    fs.copyFileSync(screenshotPath, target);
    const stat = fs.statSync(target);
    const info = readSize(target);
    const meta: BaselineMeta = {
      name,
      image: this.store.relative(target),
      createdAt: new Date().toISOString(),
      sha256: await sha256File(target),
      bytes: stat.size,
      width: info.width,
      height: info.height,
      ...extra,
    };
    await writeJson(this.metaPath(name), meta);
    // A stale diff beside a fresh baseline is misleading.
    await removeTree(path.join(this.dir(name), 'latest-diff.png')).catch(() => {});
    return { name, path: target, meta, replaced };
  }

  async read(name: string): Promise<BaselineMeta | null> {
    const meta = await readJsonOpt<BaselineMeta>(this.metaPath(name));
    if (meta && !fs.existsSync(this.imagePath(name))) return { ...meta, image: this.imagePath(name) };
    return meta;
  }

  async list(): Promise<BaselineSummary[]> {
    const root = path.join(this.store.root, 'baselines');
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
    } catch {
      return [];
    }
    const out: BaselineSummary[] = [];
    for (const dir of entries) {
      const meta = await readJsonOpt<BaselineMeta>(path.join(dir, 'meta.json'));
      const image = path.join(dir, 'baseline.png');
      const missing = !fs.existsSync(image);
      if (!meta) {
        if (!missing) {
          const stat = fs.statSync(image);
          const info = readSize(image);
          out.push({
            name: path.basename(dir),
            image: this.store.relative(image),
            createdAt: stat.mtime.toISOString(),
            sha256: await sha256File(image),
            bytes: stat.size,
            width: info.width,
            height: info.height,
            ageDays: ageInDays(stat.mtime.toISOString()),
            missing: false,
          });
        }
        continue;
      }
      out.push({ ...meta, ageDays: ageInDays(meta.createdAt), missing });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async compare(name: string, currentPath: string, options: CompareOptions = {}): Promise<BaselineCompareResult> {
    const baselineImage = this.imagePath(name);
    if (!fs.existsSync(baselineImage)) {
      return {
        name,
        verdict: 'missing-baseline',
        baseline: await this.read(name),
        comparison: null,
        suggestion: `No baseline named "${name}" exists. Once the current design is correct, run \`lens compare --update-baseline ${name}\` to create it.`,
      };
    }
    const comparison = await compareImages(baselineImage, currentPath, {
      ...options,
      diffPath: options.diffPath ?? this.diffPath(name),
    });
    const meta = await this.read(name);
    return {
      name,
      verdict: comparison.verdict,
      baseline: meta,
      comparison,
      suggestion:
        comparison.verdict === 'match'
          ? 'No action needed — the render matches the stored baseline within tolerance.'
          : comparison.verdict === 'changed'
            ? `If this change is intentional, review ${this.store.relative(comparison.diff?.path ?? 'the diff image')} and accept it with \`lens compare --update-baseline ${name}\`. Otherwise fix the regression and re-run compare.`
            : 'Inspect the diff image before deciding.',
    };
  }

  async remove(name: string): Promise<boolean> {
    const dir = this.dir(name);
    if (!fs.existsSync(dir)) return false;
    await removeTree(dir);
    return true;
  }
}

function readSize(file: string): { width: number; height: number } {
  const buffer = fs.readFileSync(file);
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

function ageInDays(iso: string): number {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.round(((Date.now() - at) / 86_400_000) * 10) / 10);
}
