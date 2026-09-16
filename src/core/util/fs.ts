/** Small filesystem + identity helpers shared across Lens. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export function ensureDirSync(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

export function isFileSync(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function readTextOpt(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export function readTextOptSync(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export async function readJsonOpt<T = unknown>(p: string): Promise<T | null> {
  const raw = await readTextOpt(p);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(
  p: string,
  value: unknown,
  opts: { pretty?: boolean } = {},
): Promise<string> {
  await ensureDir(path.dirname(p));
  const pretty = opts.pretty ?? true;
  await fsp.writeFile(p, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value), 'utf8');
  return p;
}

export async function writeText(p: string, value: string): Promise<string> {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, value, 'utf8');
  return p;
}

export async function copyFile(src: string, dest: string): Promise<string> {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
  return dest;
}

export async function fileSize(p: string): Promise<number | null> {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return null;
  }
}

export async function readBuffer(p: string): Promise<Buffer> {
  return fsp.readFile(p);
}

/** Recursively remove, tolerating missing paths. */
export async function removeTree(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

/** Directory listing that tolerates missing dirs. */
export async function listDir(p: string): Promise<string[]> {
  try {
    return (await fsp.readdir(p, { withFileTypes: true }))
      .map((e) => path.join(p, e.name))
      .sort();
  } catch {
    return [];
  }
}

export async function listDirRecursive(root: string, limit = 5000): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= limit) return;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
      if (out.length >= limit) return;
    }
  }
  if (await isDir(root)) await walk(root);
  return out.sort();
}

/** sha256 of file bytes (or of a string). */
export async function sha256File(p: string): Promise<string> {
  const buf = await fsp.readFile(p);
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

export function shortHash(input: string, length = 8): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

const STAMP_CHARS = /[^\w.\-]+/g;

/** Make a string safe to use as a file name, preserving readability. */
export function safeName(input: string, fallback = 'untitled'): string {
  const base = input
    .trim()
    .replace(/[\s/]+/g, '-')
    .replace(STAMP_CHARS, '')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return base.length >= 2 ? base : fallback;
}

/** `2026-09-16T04-11-05-123Z` — sortable and filesystem-safe. */
export function timestampSlug(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem.toString().padStart(2, '0')}s`;
}

/** Relative to project root when possible, else absolute. Keeps artifacts portable. */
export function displayPath(root: string, target: string): string {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return target;
  return `./${rel.split(path.sep).join('/')}`;
}

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(3, '0')}`;
}

/** Move a file across paths, falling back to copy+unlink on exotic mounts. */
export async function moveFile(src: string, dest: string): Promise<string> {
  await ensureDir(path.dirname(dest));
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src).catch(() => {});
  }
  return dest;
}
