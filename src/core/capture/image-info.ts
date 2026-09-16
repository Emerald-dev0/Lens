/** Image header sniffing — dimensions/format without an image library dependency. */

export interface ImageInfo {
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'unknown';
  width: number;
  height: number;
  bytes: number;
}

export function readImageInfo(buffer: Buffer): ImageInfo {
  const bytes = buffer.length;
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const size = readJpegSize(buffer);
    return { format: 'jpeg', width: size.width, height: size.height, bytes };
  }
  if (
    buffer.length > 30 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { format: 'webp', ...readWebpSize(buffer), bytes };
  }
  if (buffer.length > 10 && buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
    return { format: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), bytes };
  }
  if (buffer.length > 30 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const size = readIsoBmffSize(buffer);
    return { format: 'avif', width: size.width, height: size.height, bytes };
  }
  return { format: 'unknown', width: 0, height: 0, bytes };
}

function readJpegSize(buffer: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1] ?? 0;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const length = buffer.readUInt16BE(offset + 2);
    if (isSof) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

function readWebpSize(buffer: Buffer): { width: number; height: number } {
  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    const width = 1 + ((buffer[26] ?? 0) | ((buffer[27] ?? 0) << 8) | ((buffer[28] ?? 0) << 16));
    const height = 1 + ((buffer[29] ?? 0) | ((buffer[30] ?? 0) << 8) | ((buffer[31] ?? 0) << 16));
    return { width, height };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return { width: 0, height: 0 };
}

function readIsoBmffSize(buffer: Buffer): { width: number; height: number } {
  let offset = 0;
  while (offset + 8 < buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'ispe' && offset + 16 <= buffer.length) {
      return { width: buffer.readUInt32BE(offset + 12), height: buffer.readUInt32BE(offset + 16) };
    }
    if (size < 8) break;
    offset += size;
  }
  return { width: 0, height: 0 };
}

export function formatBytesSummary(info: ImageInfo): string {
  return `${info.format} ${info.width}x${info.height}`;
}
