/**
 * Minimal POSIX/GNU tar reader.
 *
 * Lens unpacks browser runtime archives (fonts, shared libraries) without pulling
 * in a tar dependency or shelling out to a system `tar`. Supports the subset real
 * archives use: ustar + GNU long names + pax headers, files, directories, symlinks.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;

export interface TarEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mode: number;
  linkName: string;
  buffer: Buffer | null;
}

export interface ExtractResult {
  files: string[];
  bytes: number;
}

function decodeString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.toString('utf8', 0, end === -1 ? slice.length : end).trim();
}

function decodeOctal(buf: Buffer, offset: number, length: number): number {
  const raw = decodeString(buf, offset, length).replace(/[^0-7]/g, '');
  if (!raw) return 0;
  return Number.parseInt(raw, 8) || 0;
}

/** Iterate entries of an uncompressed tar buffer. */
export function* iterateTar(buffer: Buffer): Generator<TarEntry> {
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    offset += BLOCK;

    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) return;

    const nameField = decodeString(header, 0, 100);
    const typeFlag = String.fromCharCode(header[156] ?? 0x30);
    const size = decodeOctal(header, 124, 12);
    const mode = decodeOctal(header, 100, 8);
    const linkName = decodeString(header, 157, 100);
    const prefix = decodeString(header, 345, 155);

    let name = pendingLongName ?? (prefix ? `${prefix}/${nameField}` : nameField);
    pendingLongName = null;

    const blocks = Math.ceil(size / BLOCK);
    const dataStart = offset;
    const dataEnd = dataStart + blocks * BLOCK;

    if (typeFlag === 'L') {
      // GNU long name: payload is the next entry's real path.
      pendingLongName = buffer.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0+$/, '');
      offset = dataEnd;
      continue;
    }
    if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'K') {
      const payload = buffer.subarray(dataStart, dataStart + size).toString('utf8');
      const paxName = /^[\d ]*\bpath=(.*)$/m.exec(payload)?.[1];
      if (typeFlag === 'x' && paxName) pendingLongName = paxName;
      offset = dataEnd;
      continue;
    }

    const type: TarEntry['type'] =
      typeFlag === '5' ? 'directory' : typeFlag === '2' ? 'symlink' : typeFlag === '0' || typeFlag === '\0' || typeFlag === '7' ? 'file' : 'other';

    if (type === 'file') {
      yield { name, type, size, mode, linkName, buffer: buffer.subarray(dataStart, dataStart + size) };
    } else {
      yield { name, type, size, mode, linkName, buffer: null };
    }

    offset = dataEnd;
  }
}

/** Decompress a brotli file to disk or memory. */
export async function brotliDecompressFile(file: string): Promise<Buffer> {
  const raw = await fsp.readFile(file);
  return zlib.brotliDecompressSync(raw);
}

function sanitizeName(name: string): string | null {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;
  const parts = normalized.split('/').filter((p) => p.length && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/**
 * Extract a tar buffer into `dest`.
 * Returns the list of written file paths (relative to dest).
 */
export async function extractTarTo(tar: Buffer, dest: string, options: { executableMask?: number } = {}): Promise<ExtractResult> {
  const written: string[] = [];
  let bytes = 0;
  await fsp.mkdir(dest, { recursive: true });

  for (const entry of iterateTar(tar)) {
    const rel = sanitizeName(entry.name);
    if (!rel) continue;
    const target = path.join(dest, rel);
    if (!target.startsWith(dest + path.sep) && target !== dest) continue;

    if (entry.type === 'directory') {
      await fsp.mkdir(target, { recursive: true });
      continue;
    }
    if (entry.type === 'symlink' || entry.type === 'other') continue;
    if (!entry.buffer) continue;

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, entry.buffer);
    if (entry.mode) {
      const mode = options.executableMask && (entry.mode & 0o111) !== 0 ? entry.mode | options.executableMask : entry.mode & 0o777;
      await fsp.chmod(target, mode || 0o644).catch(() => {});
    }
    written.push(rel);
    bytes += entry.size;
  }

  return { files: written, bytes };
}
