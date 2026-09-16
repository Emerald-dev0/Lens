/**
 * Screenshot capture.
 *
 * Four scopes — viewport, full page, element, clip — plus an optional hi-res device
 * scale factor. Screenshots are the evidence an agent attaches to its own work, so
 * they land in the artifact store with size, format and hash recorded.
 */
import type { CDPSession, Locator, Page } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

import type { ResolvedConfig } from '../config/load.js';
import { LensError, LensErrorCode } from '../errors.js';
import { extForFormat, type ArtifactKind } from '../artifacts/paths.js';
import { ensureDir, humanBytes, sha256File, writeJson } from '../util/fs.js';
import { log } from '../util/log.js';
import { findFfmpeg } from './ffmpeg.js';
import { readImageInfo } from './image-info.js';
import { OverlayLayer, type BoxLike } from './overlay.js';

export type ScreenshotScope = 'viewport' | 'full-page' | 'element' | 'clip';

export interface ScreenshotRequest {
  scope?: ScreenshotScope;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  omitBackground?: boolean;
  scale?: 'css' | 'device';
  /** Hi-res export: temporarily overrides the page's device pixel ratio. */
  deviceScaleFactor?: number;
  clip?: BoxLike;
  /** Draw a highlight ring around the element (element scope). */
  annotate?: boolean;
  accent?: string;
  /** Hide Lens overlays while capturing (banners, callouts). */
  hideOverlay?: boolean;
  /** Where to write. Defaults to a timestamped name in the artifact dir. */
  output?: string;
  artifactKind?: ArtifactKind;
  /** Naming hint, e.g. `homepage-after-fix`. */
  label?: string;
  /** Wait for fonts/animations to settle before capturing. */
  animations?: 'allow' | 'disabled';
  fullPageIfTall?: boolean;
}

export interface ScreenshotResult {
  path: string;
  format: 'png' | 'jpeg' | 'webp';
  scope: ScreenshotScope;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  deviceScaleFactor: number;
  url: string;
  label?: string;
  convertedFrom?: string;
  notes: string[];
}

export interface ElementTarget {
  locator: Locator;
  box: BoxLike;
  description: string;
}

export class ScreenshotService {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly store: { allocate: (kind: ArtifactKind, base: string, ext: string) => Promise<string>; relative: (p: string) => string },
  ) {}

  async capture(page: Page, request: ScreenshotRequest = {}, element?: ElementTarget): Promise<ScreenshotResult> {
    const scope: ScreenshotScope =
      request.scope ?? (element ? 'element' : request.clip ? 'clip' : this.config.capture.fullPage ? 'full-page' : 'viewport');
    const notes: string[] = [];
    let format = request.format ?? this.config.capture.format;
    const maxDpr = this.config.capture.maxDeviceScaleFactor;
    let dpr = request.deviceScaleFactor ?? 1;
    if (dpr > maxDpr) {
      notes.push(`deviceScaleFactor reduced from ${dpr} to ${maxDpr} (capture.maxDeviceScaleFactor).`);
      dpr = maxDpr;
    }

    if (scope === 'element' && !element) {
      throw LensError.usage('An element screenshot needs an element.', [
        'Example: lens screenshot --element e12',
        'Or by role: lens screenshot --element role=button[name="Save"]',
      ]);
    }

    // webp is encoded through ffmpeg when available; otherwise PNG is written and the
    // result says so, rather than silently returning a different format.
    let encoder: 'png' | 'jpeg' = format === 'webp' ? 'png' : format;
    const ffmpegPresent = findFfmpeg(this.config) !== null;
    if (format === 'webp' && !ffmpegPresent) {
      encoder = 'png';
      format = 'png';
      notes.push('webp requested but no ffmpeg was found — wrote PNG instead.');
    }

    const target =
      request.output ?? (await this.store.allocate(request.artifactKind ?? 'screenshots', request.label ?? slugFromUrl(page.url()), extForFormat(format)));
    await ensureDir(path.dirname(target));

    const needsOverlay = Boolean(request.annotate && element) || Boolean(request.hideOverlay);
    const overlay = needsOverlay ? await OverlayLayer.attach(page) : null;
    let restoreHighlight: (() => Promise<void>) | null = null;
    let cdp: CDPSession | null = null;
    let metricsOverridden = false;

    const takeShot = async (): Promise<Buffer> => {
      const base: {
        type: 'png' | 'jpeg';
        scale: 'css' | 'device';
        omitBackground: boolean;
        timeout: number;
        animations: 'allow' | 'disabled';
        caret: 'initial' | 'hide';
        quality?: number;
        fullPage?: boolean;
        clip?: BoxLike;
      } = {
        type: encoder,
        scale: request.scale ?? this.config.capture.scale,
        omitBackground: request.omitBackground ?? this.config.capture.omitBackground,
        timeout: this.config.capture.timeoutMs,
        animations: request.animations === 'disabled' ? 'disabled' : 'allow',
        caret: 'hide',
      };
      if (encoder === 'jpeg') base.quality = request.quality ?? this.config.capture.quality ?? 90;

      if (scope === 'full-page') return page.screenshot({ ...base, fullPage: true });
      if (scope === 'clip' && request.clip) return page.screenshot({ ...base, clip: request.clip });
      if (scope === 'element' && element) {
        // Annotating an element captures a padded viewport clip so the ring is visible;
        // a plain element shot uses the element's own box for an exact crop.
        if (request.annotate) return page.screenshot({ ...base, clip: pad(element.box, 14) });
        return element.locator.screenshot(base as never);
      }
      return page.screenshot(base);
    };

    try {
      if (request.annotate && element) {
        restoreHighlight = await overlay!.highlight([element.box], {
          color: request.accent ?? this.config.recording.overlay.accent,
          fill: true,
        });
      }

      if (dpr > 1) {
        const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        try {
          cdp = await page.context().newCDPSession(page);
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: size.width,
            height: size.height,
            deviceScaleFactor: dpr,
            mobile: false,
          });
          metricsOverridden = true;
          log.debug('hi-res capture', { dpr, ...size });
        } catch (err) {
          notes.push(`High-resolution mode unavailable (${firstLine(err)}); captured at 1x.`);
          dpr = 1;
        }
      }

      const capture = async (): Promise<Buffer> => (request.hideOverlay && overlay ? overlay.withHidden(takeShot) : takeShot());
      const buffer = await runCapture(capture);

      // Capture is complete: drop the ring and the metrics override before encoding.
      if (restoreHighlight) await restoreHighlight().catch(() => {});
      restoreHighlight = null;
      if (metricsOverridden && cdp) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      metricsOverridden = false;

      if (format === 'webp') {
        const tmpPng = `${target}.capture.png`;
        await fs.promises.writeFile(tmpPng, buffer);
        const converted = await convertWithFfmpeg(tmpPng, target, this.config.capture.quality ?? 90);
        await fs.promises.unlink(tmpPng).catch(() => {});
        if (converted) return this.finalize(target, 'webp', scope, dpr, page, notes, request, 'png');
        notes.push('webp conversion failed; PNG written instead.');
        format = 'png';
        await fs.promises.writeFile(target, buffer);
      } else {
        await fs.promises.writeFile(target, buffer);
      }

      return await this.finalize(target, format, scope, dpr, page, notes, request);
    } finally {
      if (restoreHighlight) await restoreHighlight().catch(() => {});
      if (metricsOverridden && cdp) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }

  private async finalize(
    target: string,
    format: 'png' | 'jpeg' | 'webp',
    scope: ScreenshotScope,
    dpr: number,
    page: Page,
    notes: string[],
    request: ScreenshotRequest,
    convertedFrom?: string,
  ): Promise<ScreenshotResult> {
    const bytes = await fs.promises.readFile(target);
    const info = readImageInfo(bytes);
    const result: ScreenshotResult = {
      path: this.store.relative(target),
      format,
      scope,
      width: info.width,
      height: info.height,
      bytes: info.bytes,
      sha256: await sha256File(target),
      deviceScaleFactor: dpr,
      url: page.url(),
      label: request.label,
      convertedFrom,
      notes,
    };
    if (this.config.capture.writeSidecar) {
      await writeJson(`${target}.json`, { ...result, absolutePath: target }).catch(() => {});
    }
    return result;
  }
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}

async function runCapture(capture: () => Promise<Buffer>): Promise<Buffer> {
  try {
    const buffer = await capture();
    if (!buffer?.length) throw new Error('empty buffer');
    return buffer;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/Cannot take screenshot larger than|Failed to screenshot|zero-sized/i.test(message)) {
      throw new LensError({
        code: LensErrorCode.RENDER_FAILED,
        message: 'The screenshot could not be captured.',
        scope: 'browser',
        detail: message.split('\n')[0],
        hints: [
          'A full-page capture of an extremely tall document can exceed the compositor limit — use --scope viewport or clip a region.',
          'A zero-sized element usually means it is display:none; check with `lens inspect --box <ref>`.',
        ],
        cause: err,
      });
    }
    throw new LensError({
      code: LensErrorCode.RENDER_FAILED,
      message: 'Screenshot capture failed.',
      scope: 'browser',
      detail: message.split('\n').slice(0, 3).join(' | '),
      hints: ['Retry after the page settles: `lens wait --idle`.', 'If the tab crashed, `lens status` reports it; re-open with `lens open <url>`.'],
      cause: err,
      retryable: true,
    });
  }
}

function pad(box: BoxLike, amount: number): BoxLike {
  return {
    x: Math.max(0, box.x - amount),
    y: Math.max(0, box.y - amount),
    width: box.width + amount * 2,
    height: box.height + amount * 2,
  };
}

async function convertWithFfmpeg(input: string, output: string, quality: number): Promise<boolean> {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return false;
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const args = ['-y', '-loglevel', 'error', '-i', input, '-update', '1', '-quality', String(Math.round(quality * 0.9)), output];
    const child = spawn(ffmpeg.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok && fs.existsSync(output) && fs.statSync(output).size > 0);
    };
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, 20_000);
  });
}

function slugFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return [parsed.hostname.replace(/\W+/g, '-'), last].filter(Boolean).join('-') || 'page';
  } catch {
    return 'page';
  }
}

export function humanSize(result: ScreenshotResult): string {
  return `${result.width}x${result.height} ${humanBytes(result.bytes)}`;
}
