/**
 * Visual regression.
 *
 * `lens compare` answers one question an agent cannot answer from source: did the
 * rendered result change in a way the author did not intend? Baselines are plain
 * PNGs in `.lens/baselines`, so they can be committed, reviewed in a PR, and
 * regenerated deliberately.
 */
import fs from 'node:fs';
import path from 'node:path';

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

import { LensError, LensErrorCode } from '../errors.js';
import { ensureDir, humanBytes, sha256 } from '../util/fs.js';
import { readImageInfo } from './image-info.js';

export interface CompareOptions {
  /** 0–1 per-pixel color distance tolerance. Lower is stricter. */
  threshold?: number;
  /** Anti-aliased pixels are ignored unless this is true. */
  includeAntiAliasing?: boolean;
  /** Fraction of changed pixels that still counts as a match. */
  toleranceRatio?: number;
  /** Where to write the diff image. Defaults beside the current capture. */
  diffPath?: string;
  /** Also write an aligned side-by-side composite. */
  composite?: boolean;
  compositePath?: string;
}

export interface CompareResult {
  verdict: 'match' | 'changed';
  changedPixels: number;
  totalPixels: number;
  changedRatio: number;
  /** 0–100 similarity score, agent-facing. */
  similarity: number;
  threshold: number;
  toleranceRatio: number;
  baseline: { path: string; width: number; height: number; bytes: number; sha256: string };
  current: { path: string; width: number; height: number; bytes: number; sha256: string };
  sizeMismatch: { baseline: Size; current: Size } | null;
  diff: { path: string; bytes: number } | null;
  composite: { path: string; bytes: number } | null;
  regions: DiffRegion[];
  notes: string[];
}

interface Size {
  width: number;
  height: number;
}

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
  /** Best-effort description of what lives there. */
  hint: string;
}

const GAP = 16;

export async function compareImages(baselinePath: string, currentPath: string, options: CompareOptions = {}): Promise<CompareResult> {
  const baseline = await readPng(baselinePath, 'baseline');
  const current = await readPng(currentPath, 'current');

  const notes: string[] = [];
  const threshold = options.threshold ?? 0.1;
  const toleranceRatio = options.toleranceRatio ?? 0.001;

  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);
  const sizeMismatch =
    baseline.width !== current.width || baseline.height !== current.height
      ? { baseline: { width: baseline.width, height: baseline.height }, current: { width: current.width, height: current.height } }
      : null;

  if (sizeMismatch) {
    notes.push(
      `Canvas sizes differ (${sizeMismatch.baseline.width}x${sizeMismatch.baseline.height} vs ${sizeMismatch.current.width}x${sizeMismatch.current.height}); both were aligned on a shared ${width}x${height} surface before comparing.`,
    );
  }

  const left = place(baseline, width, height);
  const right = place(current, width, height);
  const diff = new PNG({ width, height });

  let changedPixels: number;
  try {
    changedPixels = pixelmatch(left.data, right.data, diff.data, width, height, {
      threshold,
      includeAA: options.includeAntiAliasing ?? false,
      alpha: 0.35,
      diffColor: [255, 60, 90],
      diffColorAlt: [80, 200, 255],
    });
  } catch (err) {
    throw new LensError({
      code: LensErrorCode.REVIEW_FAILED,
      message: 'The images could not be compared.',
      scope: 'input',
      detail: (err as Error).message,
      hints: ['Both inputs must be decodable PNGs. Re-capture with `lens screenshot --format png` (JPEG recompression can also raise noise).'],
      cause: err,
    });
  }

  const totalPixels = width * height;
  const changedRatio = totalPixels ? changedPixels / totalPixels : 0;
  const verdict: CompareResult['verdict'] = changedRatio > toleranceRatio ? 'changed' : 'match';

  let diffInfo: CompareResult['diff'] = null;
  if (changedPixels > 0) {
    const target = options.diffPath ?? defaultDerivedPath(currentPath, 'diff');
    try {
      await ensureDir(path.dirname(target));
      fs.writeFileSync(target, PNG.sync.write(diff));
      diffInfo = { path: target, bytes: fs.statSync(target).size };
    } catch (err) {
      notes.push(`Diff image could not be written (${(err as Error).message.split('\n')[0]}).`);
    }
  } else if (options.diffPath) {
    // An explicit path implies the caller wants the artifact even on a clean match.
    await ensureDir(path.dirname(options.diffPath));
    fs.writeFileSync(options.diffPath, PNG.sync.write(diff));
    diffInfo = { path: options.diffPath, bytes: fs.statSync(options.diffPath).size };
  }

  let compositeInfo: CompareResult['composite'] = null;
  if (options.composite) {
    const target = options.compositePath ?? defaultDerivedPath(currentPath, 'side-by-side');
    compositeInfo = { path: target, bytes: await writeSideBySide(baseline, current, target) };
  }

  return {
    verdict,
    changedPixels,
    totalPixels,
    changedRatio: roundRatio(changedRatio),
    similarity: roundRatio(1 - Math.min(1, changedRatio)),
    threshold,
    toleranceRatio,
    baseline: await describeFile(baselinePath, baseline),
    current: await describeFile(currentPath, current),
    sizeMismatch,
    diff: diffInfo,
    composite: compositeInfo,
    regions: changedPixels ? findRegions(diff, width, height) : [],
    notes,
  };
}

/** Detect contiguous changed areas so the report can name them. */
export function findRegions(diff: PNG, width: number, height: number, max = 8): DiffRegion[] {
  const stride = width * 4;
  const visited = new Uint8Array(width * height);
  const regions: DiffRegion[] = [];
  const stack: number[] = [];

  const isMarked = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const index = y * stride + x * 4;
    // pixelmatch paints changed pixels strongly; anything non-transparent counts.
    return diff.data[index + 3] !== 0 && (diff.data[index]! > 40 || diff.data[index + 1]! > 40 || diff.data[index + 2]! > 40);
  };

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const start = y * width + x;
      if (visited[start] || !isMarked(x, y)) continue;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let pixels = 0;
      stack.length = 0;
      stack.push(start);
      visited[start] = 1;
      while (stack.length && pixels < 400_000) {
        const index = stack.pop() as number;
        const px = index % width;
        const py = (index / width) | 0;
        pixels += 1;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [2, 0],
          [-2, 0],
          [0, 2],
          [0, -2],
        ]) {
          const nx = px + (dx as number);
          const ny = py + (dy as number);
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (visited[ni] || !isMarked(nx, ny)) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }
      if (pixels < 24) continue;
      regions.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        pixels,
        hint: describeRegion(minX, minY, maxX - minX + 1, maxY - minY + 1, width, height),
      });
      if (regions.length >= max) break;
    }
    if (regions.length >= max) break;
  }

  return regions.sort((a, b) => b.pixels - a.pixels).slice(0, max);
}

function describeRegion(x: number, y: number, w: number, h: number, canvasW: number, canvasH: number): string {
  const vertical = y < canvasH * 0.16 ? 'top area' : y + h > canvasH * 0.84 ? 'bottom area' : 'middle band';
  const horizontal = x < canvasW * 0.22 ? 'left' : x + w > canvasW * 0.78 ? 'right' : 'centre';
  const size = w * h > canvasW * canvasH * 0.25 ? 'large region' : w > canvasW * 0.6 ? 'full-width strip' : h > canvasH * 0.5 ? 'tall column' : 'localised block';
  return `${size} in the ${horizontal} ${vertical}`;
}

async function readPng(file: string, label: 'baseline' | 'current'): Promise<PNG> {
  if (!fs.existsSync(file)) {
    throw new LensError({
      code: LensErrorCode.FILE_NOT_FOUND,
      message: `The ${label} image does not exist: ${file}`,
      scope: 'input',
      hints:
        label === 'baseline'
          ? ['Create a baseline with `lens compare --update-baseline <name>` once the design is right.', 'List existing baselines with `lens compare --list`.']
          : ['Capture the current state first: `lens screenshot --label current`.'],
      data: { file, label },
    });
  }
  const buffer = fs.readFileSync(file);
  const info = readImageInfo(buffer);
  if (info.format !== 'png') {
    throw new LensError({
      code: LensErrorCode.INVALID_INPUT,
      message: `The ${label} image is ${info.format}, not PNG. Pixel comparison requires lossless input.`,
      scope: 'input',
      detail: file,
      hints: [`Re-capture with \`lens screenshot --format png\`; JPEG and webp artefacts introduce compression noise that reads as change.`],
    });
  }
  try {
    return PNG.sync.read(buffer);
  } catch (err) {
    throw new LensError({
      code: LensErrorCode.FILE_UNREADABLE,
      message: `The ${label} PNG could not be decoded.`,
      scope: 'input',
      detail: `${file}: ${(err as Error).message}`,
      hints: ['The file may be truncated. Re-capture it.'],
      cause: err,
    });
  }
}

/** Copy an image into a shared canvas, top-left aligned, on a neutral background. */
function place(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  out.data.fill(0);
  // Neutral, non-white backdrop so transparent edges stay transparent on both sides.
  for (let i = 0; i < width * height; i += 1) {
    out.data[i * 4] = 255;
    out.data[i * 4 + 1] = 255;
    out.data[i * 4 + 2] = 255;
    out.data[i * 4 + 3] = 255;
  }
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const src = (png.width * y + x) << 2;
      const dst = (width * y + x) << 2;
      for (let c = 0; c < 4; c += 1) out.data[dst + c] = png.data[src + c] ?? 0;
    }
  }
  return out;
}

async function describeFile(file: string, png: PNG): Promise<CompareResult['baseline']> {
  const buffer = fs.readFileSync(file);
  return {
    path: file,
    width: png.width,
    height: png.height,
    bytes: buffer.length,
    sha256: sha256(buffer.toString('base64')),
  };
}

function defaultDerivedPath(reference: string, suffix: string): string {
  const dir = path.dirname(reference);
  const base = path.basename(reference, path.extname(reference));
  return path.join(dir, `${base}.${suffix}.png`);
}

function roundRatio(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

/** Build `baseline | current` side by side for PR review. */
async function writeSideBySide(baseline: PNG, current: PNG, target: string): Promise<number> {
  const width = baseline.width + current.width + GAP * 3;
  const height = Math.max(baseline.height, current.height) + GAP * 2;
  const out = new PNG({ width, height });
  out.data.fill(0xff);
  const blit = (png: PNG, offsetX: number, offsetY: number) => {
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const src = (png.width * y + x) << 2;
        const dst = (width * (y + offsetY) + (x + offsetX)) << 2;
        const alpha = png.data[src + 3]! / 255;
        for (let c = 0; c < 3; c += 1) {
          const targetValue = out.data[dst + c] ?? 255;
          out.data[dst + c] = Math.round(((png.data[src + c] ?? 0) * alpha + targetValue * (1 - alpha)) | 0);
        }
        out.data[dst + 3] = 255;
      }
    }
  };
  blit(baseline, GAP, GAP);
  blit(current, GAP * 2 + baseline.width, GAP);
  await ensureDir(path.dirname(target));
  fs.writeFileSync(target, PNG.sync.write(out));
  return fs.statSync(target).size;
}

export function formatCompareSummary(result: CompareResult): string {
  const percent = (result.changedRatio * 100).toFixed(result.changedRatio < 0.001 ? 4 : 2);
  return [
    `${result.verdict === 'match' ? 'No meaningful visual change' : 'Visual change detected'}`,
    `  changed ${percent}% (${result.changedPixels.toLocaleString('en-US')} of ${result.totalPixels.toLocaleString('en-US')} px, tolerance ${(result.toleranceRatio * 100).toFixed(3)}%)`,
    `  baseline ${result.baseline.width}x${result.baseline.height} ${humanBytes(result.baseline.bytes)} · current ${result.current.width}x${result.current.height} ${humanBytes(result.current.bytes)}`,
    result.sizeMismatch ? '  note: dimensions differed; aligned on a shared canvas before comparing' : '',
    ...result.regions.slice(0, 4).map((r) => `  region: ${r.hint} at ${r.x},${r.y} ${r.width}x${r.height} (${r.pixels}px)`),
  ]
    .filter(Boolean)
    .join('\n');
}
