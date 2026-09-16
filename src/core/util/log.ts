/** Structured debug logging. Off by default; agents get artifacts, not log spam. */

export type LogLevel = 'silent' | 'info' | 'debug';

let level: LogLevel = 'silent';

export function setLogLevel(next: LogLevel | string): void {
  const normalized = String(next).toLowerCase();
  level =
    normalized === 'debug'
      ? 'debug'
      : normalized === 'info'
        ? 'info'
        : normalized === 'silent' || normalized === ''
          ? 'silent'
          : 'silent';
}

export function getLogLevel(): LogLevel {
  return level;
}

function emit(kind: string, msg: string, extra?: unknown): void {
  if (level === 'silent') return;
  const line = `[lens ${kind}] ${msg}`;
  const suffix = extra === undefined ? '' : ` ${safeInspect(extra)}`;
  process.stderr.write(`${line}${suffix}\n`);
}

export const log = {
  info(msg: string, extra?: unknown): void {
    if (level !== 'silent') emit('info', msg, extra);
  },
  debug(msg: string, extra?: unknown): void {
    if (level === 'debug') emit('debug', msg, extra);
  },
  warn(msg: string, extra?: unknown): void {
    if (level !== 'silent') emit('warn', msg, extra);
  },
  error(msg: string, extra?: unknown): void {
    emit('error', msg, extra);
  },
};

function safeInspect(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
