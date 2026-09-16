/**
 * ffmpeg discovery and Playwright video provisioning.
 *
 * Two things need ffmpeg, for different reasons:
 *
 *  1. Playwright's `recordVideo` shells out to a *specific* ffmpeg it expects at
 *     a path like `~/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux`. If that file is missing the
 *     call throws before recording starts — even though a perfectly good ffmpeg is
 *     one path lookup away. Lens bridges that gap instead of failing the user.
 *  2. WebM→MP4 conversion and screencast assembly are optional polish: when no
 *     ffmpeg exists, Lens still produces WebM and reports why MP4 was skipped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { LensConfig } from '../config/schema.js';
import { isFileSync, pathExistsSync, readTextOptSync } from '../util/fs.js';
import { log } from '../util/log.js';
import { lensCacheDir } from '../browser/provision.js';

export interface FfmpegHandle {
  path: string;
  source: 'config' | 'env' | 'path' | 'playwright-cache' | 'node-module' | 'lens-cache';
  version?: string;
}

const CACHE_BINARY = 'ffmpeg';

export function findFfmpeg(config?: Partial<Pick<LensConfig, 'recording'>>): FfmpegHandle | null {
  const fromConfig = config?.recording?.ffmpegPath;
  if (fromConfig) {
    const resolved = path.resolve(fromConfig);
    if (isFileSync(resolved)) return { path: resolved, source: 'config' };
  }
  const fromEnv = process.env.LENS_FFMPEG ?? process.env.FFMPEG_PATH;
  if (fromEnv && isFileSync(path.resolve(fromEnv))) return { path: path.resolve(fromEnv), source: 'env' };

  const fromPath = which('ffmpeg');
  if (fromPath) return { path: fromPath, source: 'path' };

  const playwright = findPlaywrightFfmpeg();
  if (playwright) return { path: playwright, source: 'playwright-cache' };

  const nodeModule = findNodeModuleFfmpeg();
  if (nodeModule) return { path: nodeModule, source: 'node-module' };

  const cached = path.join(lensCacheDir(), 'tools', CACHE_BINARY);
  if (isFileSync(cached)) return { path: cached, source: 'lens-cache' };

  return null;
}

/** The binary Playwright will exec when a context has `recordVideo` enabled. */
export function findPlaywrightFfmpeg(): string | null {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  const bases = [root && root !== '0' ? root : path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  const names =
    process.platform === 'win32'
      ? ['ffmpeg-win.exe', 'ffmpeg-win32-x64.exe', 'ffmpeg.exe']
      : process.platform === 'darwin'
        ? ['ffmpeg-mac', 'ffmpeg-apple-arm64', 'ffmpeg']
        : ['ffmpeg-linux', 'ffmpeg-linux-arm64', 'ffmpeg'];

  for (const base of bases) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.startsWith('ffmpeg-')).sort().reverse()) {
      for (const name of names) {
        const candidate = path.join(base, entry, name);
        if (isFileSync(candidate)) return candidate;
      }
      // Some builds ship a single executable file named after the directory.
      const dir = path.join(base, entry);
      try {
        for (const file of fs.readdirSync(dir)) {
          const candidate = path.join(dir, file);
          if (file.startsWith('ffmpeg') && isFileSync(candidate) && isExecutable(candidate)) return candidate;
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return null;
}

function findNodeModuleFfmpeg(): string | null {
  const candidates = [
    '@ffmpeg-installer/linux-x64/ffmpeg',
    '@ffmpeg-installer/darwin-x64/ffmpeg',
    '@ffmpeg-installer/darwin-arm64/ffmpeg',
    '@ffmpeg-installer/win32-x64/ffmpeg',
    'ffmpeg-static/ffmpeg',
  ];
  const roots = [process.cwd()];
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    roots.push((dir = parent));
  }
  for (const root of roots) {
    for (const candidate of candidates) {
      const full = path.join(root, 'node_modules', candidate);
      if (isFileSync(full)) return full;
    }
  }
  return null;
}

function which(binary: string): string | null {
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', ''] : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      if (isFileSync(candidate) && (isWin || isExecutable(candidate))) return candidate;
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `recordVideo` work without `npx playwright install ffmpeg`: copy (or link)
 * the discovered binary into the ms-playwright cache layout Playwright insists on.
 * Returns the path that was created, or null when nothing is available.
 */
export function provisionPlaywrightFfmpeg(): { path: string; created: boolean; source: FfmpegHandle['source'] } | null {
  const handle = findFfmpeg();
  if (!handle) return null;

  const base = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  const root = base && base !== '0' ? base : path.join(os.homedir(), '.cache', 'ms-playwright');
  const targetName = process.platform === 'win32' ? 'ffmpeg-win.exe' : process.platform === 'darwin' ? 'ffmpeg-mac' : 'ffmpeg-linux';
  const dir = path.join(root, 'ffmpeg-1011');
  const target = path.join(dir, targetName);
  if (fs.existsSync(target)) return { path: target, created: false, source: handle.source };
  if (handle.source === 'playwright-cache') return { path: handle.path, created: false, source: handle.source };

  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.linkSync(handle.path, target);
    } catch {
      fs.copyFileSync(handle.path, target);
    }
    fs.chmodSync(target, 0o755);
    log.info('provisioned ffmpeg for Playwright video capture', { target, source: handle.path });
    return { path: target, created: true, source: handle.source };
  } catch (err) {
    log.debug('could not provision Playwright ffmpeg', { error: (err as Error).message });
    return null;
  }
}

export interface ConversionResult {
  ok: boolean;
  input: string;
  output?: string;
  skippedReason?: string;
  stderr?: string;
  durationMs: number;
}

/** Convert WebM → MP4 (H.264 + yuv420p so social/preview tools accept it). */
export async function convertVideo(input: string, output: string, config?: Partial<Pick<LensConfig, 'recording'>>): Promise<ConversionResult> {
  const started = Date.now();
  const handle = findFfmpeg(config);
  if (!handle) {
    return {
      ok: false,
      input,
      output,
      skippedReason:
        'No ffmpeg was found, so MP4 conversion was skipped. Install ffmpeg, or `npm i -D @ffmpeg-installer/ffmpeg`, or set recording.ffmpegPath.',
      durationMs: 0,
    };
  }
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const args = [
      '-y',
      '-loglevel',
      'error',
      '-i',
      input,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      output,
    ];
    const child = spawn(handle.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => {
      resolve({ ok: false, input, output, skippedReason: `ffmpeg could not run: ${err.message}`, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      if (code === 0 && isFileSync(output)) {
        resolve({ ok: true, input, output, durationMs: Date.now() - started });
      } else {
        resolve({
          ok: false,
          input,
          output,
          skippedReason: `ffmpeg exited with code ${String(code)}`,
          stderr: stderr || readTextOptSync(output) || undefined,
          durationMs: Date.now() - started,
        });
      }
    });
  });
}

export async function probeVideo(file: string): Promise<{ durationMs: number | null; width: number | null; height: number | null; fps: number | null }> {
  const handle = findFfmpeg();
  if (!handle) return { durationMs: null, width: null, height: null, fps: null };
  // `ffmpeg -i` prints stream info on stderr and exits non-zero; that is enough.
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(handle.path, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 15_000 });
  const text = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const stream = /Stream:.*Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(text);
  const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(text);
  return {
    durationMs: duration ? (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000 : null,
    width: stream?.[1] ? Number(stream[1]) : null,
    height: stream?.[2] ? Number(stream[2]) : null,
    fps: fps?.[1] ? Number(fps[1]) : null,
  };
}

export function ffmpegAvailable(config?: Partial<Pick<LensConfig, 'recording'>>): boolean {
  return findFfmpeg(config) !== null;
}
