/** Config discovery, merging and validation. */
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { LensError, LensErrorCode } from '../errors.js';
import { isFileSync, pathExistsSync, readJsonOpt, readTextOpt } from '../util/fs.js';
import { DEFAULT_VIEWPORT_PROFILES, lensConfigSchema, type LensConfig, type LensConfigInput, type ViewportProfile } from './schema.js';

export type { ViewportProfile } from './schema.js';
export { viewportProfileSchema, DEFAULT_RESPONSIVE_ORDER, DEFAULT_VIEWPORT_PROFILES } from './schema.js';

export const CONFIG_FILE_NAMES = ['lens.config.json', 'lens.config.mjs', '.lens/config.json', '.lensrc.json'];

type Json = Record<string, unknown>;

export interface ResolvedConfig extends LensConfig {
  /** Project root the config was resolved against. */
  root: string;
  /** Absolute artifact directory (`.lens` by default). */
  artifactPath: string;
  /** Where config came from, for `lens config` diagnostics. */
  sources: string[];
}

export interface LoadConfigOptions {
  /** Directory to start discovery from. Defaults to `$PWD`. */
  cwd?: string;
  /** Explicit project root (skips upward discovery). */
  root?: string;
  /** Overrides applied after file config, before env. */
  overrides?: LensConfigInput;
  /** Apply `LENS_*` environment variables. Default true. */
  env?: NodeJS.ProcessEnv;
  /** Skip file discovery (use for tests / isolated runs). */
  skipFiles?: boolean;
}

/**
 * Walk up from `cwd` to find the project root: nearest directory containing
 * `package.json`, `.git`, or an existing Lens config.
 */
export function findProjectRoot(start: string): string {
  let dir = path.resolve(start);
  const markers = ['package.json', '.git', 'lens.config.json', '.lensrc.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'composer.json'];
  const fallback = dir;
  for (let depth = 0; depth < 12; depth += 1) {
    if (markers.some((m) => pathExistsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? env.PWD ?? process.cwd());
  const root = path.resolve(options.root ?? env.LENS_PROJECT_DIR ?? findProjectRoot(cwd));

  const merged: Json = {};
  const sources: string[] = [];

  if (!options.skipFiles) {
    for (const file of CONFIG_FILE_NAMES) {
      const full = path.join(root, file);
      if (!isFileSync(full)) continue;
      const parsed = await readConfigFile(full);
      if (!parsed) continue;
      deepMerge(merged, parsed);
      sources.push(path.relative(root, full).split(path.sep).join('/'));
    }
    const pkg = await readJsonOpt<Json>(path.join(root, 'package.json'));
    if (pkg && typeof pkg.lens === 'object' && pkg.lens !== null) {
      deepMerge(merged, pkg.lens as Json);
      sources.push('package.json#lens');
    }
  }

  if (options.overrides) deepMerge(merged, options.overrides as Json);

  const fromEnv = envOverrides(env);
  if (Object.keys(fromEnv).length) {
    deepMerge(merged, fromEnv);
    sources.push('environment');
  }

  const parsed = lensConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new LensError({
      code: LensErrorCode.CONFIG_INVALID,
      message: 'Lens configuration is invalid.',
      scope: 'input',
      detail: `Issues:\n${issues}\nFiles consulted: ${sources.length ? sources.join(', ') : '(none)'}`,
      hints: [
        'Fix the offending keys in lens.config.json (all values are optional; deleting the key restores the default).',
        'Run `lens config --show-defaults` to see the full default shape.',
      ],
      data: { sources, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }

  const config = parsed.data as LensConfig;
  const artifactPath = path.resolve(root, config.artifactDir);

  return {
    ...config,
    root,
    artifactPath,
    sources,
    profiles: { ...DEFAULT_VIEWPORT_PROFILES, ...config.profiles },
  };
}

async function readConfigFile(full: string): Promise<Json | null> {
  if (full.endsWith('.mjs') || full.endsWith('.js')) {
    try {
      const mod = (await import(pathToFileURL(full).href)) as { default?: unknown };
      const value = typeof mod.default === 'function' ? await mod.default() : mod.default;
      return value && typeof value === 'object' ? (value as Json) : null;
    } catch (err) {
      throw new LensError({
        code: LensErrorCode.CONFIG_INVALID,
        message: `Lens config ${path.basename(full)} could not be loaded.`,
        scope: 'input',
        detail: (err as Error).message,
        hints: ['Check the file is valid ESM and default-exports an object (or a function returning one).'],
        cause: err,
      });
    }
  }
  const raw = await readTextOpt(full);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Json;
  } catch (err) {
    throw new LensError({
      code: LensErrorCode.CONFIG_INVALID,
      message: `${path.basename(full)} is not valid JSON.`,
      scope: 'input',
      detail: (err as Error).message,
      hints: ['JSON does not allow comments or trailing commas. Remove them, or move advanced config to lens.config.mjs.'],
      cause: err,
    });
  }
}

function envOverrides(env: NodeJS.ProcessEnv): Json {
  const out: Json = {};
  const set = (pathParts: string[], value: unknown) => {
    let node = out;
    for (let i = 0; i < pathParts.length - 1; i += 1) {
      const key = pathParts[i] as string;
      node[key] ??= {};
      node = node[key] as Json;
    }
    node[pathParts[pathParts.length - 1] as string] = value;
  };
  const bool = (v: string) => !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
  const num = (v: string) => Number(v);
  const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

  const map: Array<[string, string[], (raw: string) => unknown]> = [
    ['LENS_HEADLESS', ['browser', 'headless'], bool],
    ['LENS_BROWSER_EXECUTABLE', ['browser', 'executablePath'], (v) => v],
    ['LENS_BROWSER_CHANNEL', ['browser', 'channel'], (v) => v],
    ['LENS_BROWSER_ENGINE', ['browser', 'engine'], (v) => v],
    ['LENS_SLOWMO', ['browser', 'slowMoMs'], num],
    ['LENS_DEVICE', ['browser', 'device'], (v) => v],
    ['LENS_ARTIFACT_DIR', ['artifactDir'], (v) => v],
    ['LENS_BASE_URL', ['baseUrl'], (v) => v],
    ['LENS_ALLOW_EXTERNAL', ['security', 'allowExternal'], bool],
    ['LENS_ALLOWED_ORIGINS', ['security', 'allowedOrigins'], list],
    ['LENS_BLOCKED_ORIGINS', ['security', 'blockedOrigins'], list],
    ['LENS_STORAGE_STATE', ['security', 'storageState'], (v) => v],
    ['LENS_NO_REDACT', ['security', 'redactSensitive'], (v) => !bool(v)],
    ['LENS_VIEWPORT', ['viewport'], parseViewport],
    ['LENS_TIMEOUT', ['defaults', 'navigationTimeoutMs'], num],
    ['LENS_ACTION_TIMEOUT', ['defaults', 'actionTimeoutMs'], num],
    ['LENS_SETTLE', ['defaults', 'settleMs'], num],
    ['LENS_WAIT_FOR', ['defaults', 'waitFor'], (v) => v],
    ['LENS_FORMAT', ['capture', 'format'], (v) => v],
    ['LENS_FULL_PAGE', ['capture', 'fullPage'], bool],
    ['LENS_RECORDING_MODE', ['recording', 'mode'], (v) => v],
    ['LENS_FFMPEG', ['recording', 'ffmpegPath'], (v) => v],
    ['LENS_CONVERT_MP4', ['recording', 'convert'], (v) => (bool(v) ? 'always' : 'never')],
    ['LENS_REVIEW_CHECKS', ['review', 'checks'], list],
    ['LENS_RESPONSEIVE_PROFILES', ['responsive', 'profiles'], list],
    ['LENS_DEV_SERVER_URL', ['devServer', 'url'], (v) => v],
    ['LENS_DEV_SERVER_COMMAND', ['devServer', 'command'], (v) => v],
    ['LENS_DAEMON_DISABLE', ['daemon', 'autoStart'], (v) => !bool(v)],
    ['LENS_DAEMON_IDLE_MS', ['daemon', 'idleTimeoutMs'], num],
    ['LENS_MCP_INLINE_IMAGES', ['mcp', 'inlineImages'], bool],
  ];

  for (const [key, target, transform] of map) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    let value: unknown;
    try {
      value = transform(raw);
    } catch {
      value = raw;
    }
    set(target, value);
  }
  return out;
}

function parseViewport(raw: string): unknown {
  const [w, h, d] = raw.split(/x|,/i);
  const width = Number(w);
  const height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return raw;
  const scale = d ? Number(d) : undefined;
  return { width, height, ...(Number.isFinite(scale) ? { deviceScaleFactor: scale } : {}) };
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepMerge(target: Json, source: Json): Json {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key] as Json, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/** Resolve a named viewport profile, or an inline `WxH[xD]` spec. */
export function resolveViewportProfile(config: LensConfig, spec: string | undefined): { name: string; profile: ViewportProfile } {
  if (!spec) {
    return { name: 'default', profile: { ...config.viewport, label: 'Default' } };
  }
  const key = spec.trim().toLowerCase();
  const named = config.profiles[key] ?? config.profiles[spec];
  if (named) return { name: config.profiles[key] ? key : spec, profile: named };

  const match = /^(?<w>\d{2,5})\s*[x×]\s*(?<h>\d{2,5})(?:\s*@\s*(?<d>[0-9.]+))?$/i.exec(spec.trim());
  if (match?.groups?.w && match.groups.h) {
    const width = Number(match.groups.w);
    const height = Number(match.groups.h);
    const deviceScaleFactor = match.groups.d ? Number(match.groups.d) : 1;
    if (Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0) {
      return { name: spec.trim(), profile: { width, height, deviceScaleFactor, label: spec.trim() } };
    }
  }

  throw new LensError({
    code: LensErrorCode.INVALID_INPUT,
    message: `Unknown viewport "${spec}".`,
    scope: 'input',
    detail: `Configured profiles: ${Object.keys(config.profiles).join(', ')}`,
    hints: ['Use a configured profile name, or an explicit size like 1280x800 (optionally 1280x800@2).'],
    data: { available: Object.keys(config.profiles) },
  });
}
