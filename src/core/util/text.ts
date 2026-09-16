/** Text helpers for agent-facing output and matching. */

export function truncate(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(0, max - 1))}…`;
}

export function slugKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

/** Case/diagnostic-insensitive equality used for profile and command matching. */
export function sameToken(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

/** Deterministic ordering helper for stable agent output. */
export function byString<T>(key: (item: T) => string) {
  return (a: T, b: T): number => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function uniqBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

/** Escape for `new RegExp` safety when building text selectors. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Parse `KEY=VALUE` argument lists (`--env FOO=bar`). */
export function parseKeyValue(items: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items ?? []) {
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    out[item.slice(0, eq).trim()] = item.slice(eq + 1);
  }
  return out;
}

export function parseJsonArg<T>(label: string, raw: string | undefined, fallback: T): T {
  if (raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`--${label} is not valid JSON: ${(err as Error).message}`);
  }
}
