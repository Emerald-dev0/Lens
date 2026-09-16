/**
 * Browser provisioning.
 *
 * Lens needs a Chromium binary it owns — not the user's Chrome profile, and not a
 * download that can fail at the worst moment. Resolution order is explicit and
 * reported, so `lens doctor` can explain exactly why a browser was chosen:
 *
 *   1. `browser.executablePath` (or `LENS_BROWSER_EXECUTABLE`)
 *   2. `browser.channel` (chrome / msedge, resolved by Playwright)
 *   3. a Playwright-managed Chromium already on disk
 *   4. a system Chromium/Chrome install
 *   5. `@sparticuz/chromium` from node_modules, unpacked into the Lens cache
 *
 * Step 5 is what makes Lens usable in locked-down containers: no CDN access,
 * no root, no apt — the runtime arrives through the same package registry the
 * project already uses.
 */
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { LensError, LensErrorCode } from '../errors.js';
import { ensureDir, isFileSync, pathExists, readJsonOpt, sha256, writeJson } from '../util/fs.js';
import { brotliDecompressFile, extractTarTo } from '../util/tar.js';
import { log } from '../util/log.js';
export interface ProvisionConfig {
  root?: string;
  browser: {
    engine: 'chromium' | 'firefox' | 'webkit';
    channel?: string;
    executablePath?: string;
  };
}

export type BrowserSource = 'config' | 'channel' | 'playwright' | 'system' | 'npm-package';

export interface ProvisionedBrowser {
  /** Absolute path to the executable. */
  executablePath: string;
  source: BrowserSource;
  label: string;
  /** Environment to launch with (isolated library paths for extracted runtimes). */
  env: Record<string, string>;
  /** Additional flags that this particular build needs. */
  args: string[];
  /** True when the binary was unpacked by Lens into its cache. */
  provisioned: boolean;
  notes: string[];
}

export interface ProvisionOptions {
  /** Do not unpack/extract; only look for existing binaries. */
  readonly?: boolean;
  /** Package to use for the node_modules fallback. */
  package?: string;
  /** Override cache directory. */
  cacheDir?: string;
}

const SYSTEM_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  linux: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/usr/lib/chromium/chromium',
    '/usr/bin/chrome',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

export function lensCacheDir(): string {
  const fromEnv = process.env.LENS_CACHE_DIR;
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  if (fromEnv) return path.resolve(process.cwd(), fromEnv);
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'lens');
}

export async function provisionBrowser(config: ProvisionConfig, options: ProvisionOptions = {}): Promise<ProvisionedBrowser> {
  const engine = config.browser.engine;
  const notes: string[] = [];

  const explicit = config.browser.executablePath;
  if (explicit) {
    const resolved = path.resolve(config.root ?? process.cwd(), expandHome(explicit));
    if (await isFileSync(resolved)) {
      notes.push(`Using browser.executablePath from configuration: ${resolved}`);
      return {
        executablePath: resolved,
        source: 'config',
        label: `custom (${path.basename(resolved)})`,
        env: {},
        args: [],
        provisioned: false,
        notes,
      };
    }
    throw new LensError({
      code: LensErrorCode.BROWSER_NOT_FOUND,
      message: `browser.executablePath points at a file that does not exist: ${resolved}`,
      scope: 'environment',
      hints: [
        'Correct browser.executablePath in lens.config.json or unset it to let Lens locate a browser.',
        'Install a Playwright-managed browser with `npx playwright install chromium`.',
      ],
      data: { executablePath: resolved },
    });
  }

  // Playwright-resolved channel (chrome/msedge) or installed managed browser.
  const fromPlaywright = await resolvePlaywrightBrowser(engine, config.browser.channel, notes);
  if (fromPlaywright) {
    return {
      executablePath: fromPlaywright,
      source: config.browser.channel ? 'channel' : 'playwright',
      label: config.browser.channel ? `playwright channel ${config.browser.channel}` : 'playwright-managed chromium',
      env: {},
      args: [],
      provisioned: false,
      notes,
    };
  }

  const system = await findSystemBrowser(engine);
  if (system) {
    notes.push(`Using system browser ${system}; Lens still runs it in an isolated profile.`);
    return {
      executablePath: system,
      source: 'system',
      label: `system (${path.basename(system)})`,
      env: {},
      args: [],
      provisioned: false,
      notes,
    };
  }

  if (engine !== 'chromium') {
    throw new LensError({
      code: LensErrorCode.BROWSER_NOT_FOUND,
      message: `No ${engine} runtime was found.`,
      scope: 'environment',
      detail: 'Lens falls back to a Chromium package in node_modules; Firefox/WebKit must come from a Playwright install.',
      hints: [`Install it with \`npx playwright install ${engine}\`, or set browser.engine to "chromium" (the default and best-supported engine).`],
      data: { engine },
    });
  }

  if (options.readonly) {
    throw noBrowserError(notes);
  }

  const extracted = await extractFromPackage(options.package ?? '@sparticuz/chromium', options.cacheDir, notes);
  if (extracted) return extracted;

  throw noBrowserError(notes);
}

function noBrowserError(notes: string[]): LensError {
  return new LensError({
    code: LensErrorCode.BROWSER_NOT_FOUND,
    message: 'Lens could not locate a browser runtime.',
    scope: 'environment',
    detail: notes.length ? notes.join('\n') : undefined,
    hints: [
      'Preferred: `npx playwright install chromium --with-deps` (downloads Playwright’s pinned Chromium).',
      'Air-gapped/container fallback: `npm install -D @sparticuz/chromium` — Lens unpacks it into its cache with no network access at run time.',
      'Or point Lens at an existing install: set browser.executablePath in lens.config.json, or LENS_BROWSER_EXECUTABLE=/path/to/chrome.',
      'Run `lens doctor` to see what Lens looked for.',
    ],
  });
}

async function resolvePlaywrightBrowser(engine: ProvisionConfig['browser']['engine'], channel: string | undefined, notes: string[]): Promise<string | null> {
  try {
    const mod = (await import('playwright-core')) as {
      chromium: { executablePath: (opts?: { channel?: string }) => string };
      firefox: { executablePath: () => string };
      webkit: { executablePath: () => string };
    };
    const browserType = engine === 'firefox' ? mod.firefox : engine === 'webkit' ? mod.webkit : mod.chromium;
    const target = browserType.executablePath(channel ? { channel } : undefined);
    if (await pathExists(target)) {
      notes.push(`Playwright resolved ${target}.`);
      return target;
    }
    notes.push(`Playwright points at ${target}, which is not installed.`);
    return null;
  } catch (err) {
    notes.push(`Playwright browser lookup failed: ${(err as Error).message.split('\n')[0]}`);
    return null;
  }
}

async function findSystemBrowser(engine: ProvisionConfig['browser']['engine']): Promise<string | null> {
  const list = SYSTEM_CANDIDATES[process.platform] ?? [];
  const filtered = engine === 'chromium' ? list : [];
  for (const candidate of filtered) {
    if (await isFileSync(candidate)) return candidate;
  }
  // `which` for a couple of common names, to catch non-standard installs.
  const names = ['chromium', 'chromium-browser', 'google-chrome', 'chrome'];
  for (const name of names) {
    const found = await which(name);
    if (found && (await isFileSync(found))) return found;
  }
  return null;
}

async function which(binary: string): Promise<string | null> {
  const { spawnSync } = await import('node:child_process');
  const isWin = process.platform === 'win32';
  const res = spawnSync(isWin ? 'where' : 'which', [binary], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return null;
  return res.stdout.split('\n')[0]?.trim() || null;
}

interface ProvisionMarker {
  schema: 1;
  createdAt: string;
  package: string;
  fingerprint: string;
  files: number;
}

async function extractFromPackage(
  packageName: string,
  cacheDirOverride: string | undefined,
  notes: string[],
): Promise<ProvisionedBrowser | null> {
  const binDir = await locatePackageBin(packageName, notes);
  if (!binDir) return null;

  const cache = cacheDirOverride ?? path.join(lensCacheDir(), 'browsers', safeSegment(packageName));
  const markerPath = path.join(cache, 'provision.json');
  const fingerprint = await fingerprintBinDir(binDir);

  const existing = await readJsonOpt<ProvisionMarker>(markerPath);
  const executable = path.join(cache, 'chrome');
  const canReuse = existing?.fingerprint === fingerprint && (await isFileSync(executable));
  if (canReuse) {
    // The bundled libraries live beside the executable; the launch environment has
    // to be rebuilt from the cache layout, not remembered, or the binary cannot load.
    const cachedLibs = path.join(cache, 'runtime-libs', 'lib');
    const libsPresent = (await pathExists(cachedLibs)) ? cachedLibs : undefined;
    if (!libsPresent) notes.push('Cached runtime has no bundled libraries; relying on system loader paths.');
    else notes.push(`Reusing bundled shared libraries from ${cachedLibs}.`);
    return built(executable, cache, packageName, true, [...notes, 'Extraction skipped: cache is up to date.'], libsPresent);
  }

  await ensureDir(cache);
  const started = Date.now();
  log.info('provisioning browser runtime', { binDir, cache });

  const chromiumBr = path.join(binDir, 'chromium.br');
  if (!(await isFileSync(chromiumBr))) {
    notes.push(`${packageName} has no bin/chromium.br — expected a brotli-compressed Chromium.`);
    return null;
  }

  const raw = await brotliDecompressFile(chromiumBr);
  await fsp.mkdir(path.dirname(executable), { recursive: true });
  await fsp.writeFile(executable, raw);
  await fsp.chmod(executable, 0o755);

  // Fonts are extracted for an opt-in FONTCONFIG_FILE, never activated by default:
  // see the note in `built()` below.
  await maybeExtractTar(path.join(binDir, 'fonts.tar.br'), path.join(cache, 'fonts'), undefined, notes);
  // Bundled shared libraries make the build runnable without a package manager.
  const libDir = await maybeExtractTar(path.join(binDir, 'al2023.tar.br'), path.join(cache, 'runtime-libs'), undefined, notes, true);
  const libsPath = libDir ? path.join(libDir, 'lib') : null;
  if (libsPath && (await pathExists(libsPath))) {
    notes.push(`Using bundled shared libraries from ${libsPath}.`);
  }

  await writeJson(markerPath, {
    schema: 1,
    createdAt: new Date().toISOString(),
    package: packageName,
    fingerprint,
    files: 1,
  } satisfies ProvisionMarker);

  notes.push(`Unpacked ${packageName} into ${cache} in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  log.debug('browser provisioned', { cache, ms: Date.now() - started });
  return built(executable, cache, packageName, true, notes, libsPath ?? undefined);
}

function built(
  executable: string,
  cache: string,
  packageName: string,
  provisioned: boolean,
  notes: string[],
  libsPath?: string,
): ProvisionedBrowser {
  const env: Record<string, string> = {};
  if (libsPath) {
    const current = process.env.LD_LIBRARY_PATH;
    env.LD_LIBRARY_PATH = current && !current.includes(libsPath) ? `${libsPath}:${current}` : libsPath;
  }
  // @sparticuz ships a Lambda `fonts.conf` whose `<config>` block is empty. Pointing
  // FONTCONFIG_FILE at it makes Skia take its custom-config path and abort the whole
  // browser with `FATAL: SkFontMgr_FontConfigInterface.cpp Not implemented`, and
  // FONTCONFIG_PATH alone drops glyph coverage in screenshots. So Lens extracts the
  // fonts but leaves fontconfig to the system by default; `browser.fontConfig` opts in.
  env.LENS_PROVISIONED_BROWSER = packageName;
  return {
    executablePath: executable,
    source: 'npm-package',
    label: `${packageName} (Lens-provisioned)`,
    env,
    args: ['--disable-dev-shm-usage'],
    provisioned,
    notes,
  };
}

async function maybeExtractTar(
  archive: string,
  dest: string,
  envKey: string | undefined,
  notes: string[],
  keepTopLevelLib = false,
): Promise<string | null> {
  if (!(await pathExists(archive))) {
    notes.push(`Optional archive not present: ${path.basename(archive)}`);
    return null;
  }
  if (await pathExists(dest)) {
    const entries = await fsp.readdir(dest).catch(() => [] as string[]);
    if (entries.length > 0) return dest;
  }
  try {
    const decompressed = await brotliDecompressFile(archive);
    await extractTarTo(decompressed, dest, { executableMask: 0o555 });
    if (envKey) notes.push(`Set ${envKey} for ${path.basename(archive)} → ${dest}`);
    // `al2023.tar.br` contains a `lib/` directory; keep that shape for the loader.
    if (keepTopLevelLib) return dest;
    return dest;
  } catch (err) {
    notes.push(`Could not extract ${path.basename(archive)}: ${(err as Error).message}`);
    return null;
  }
}

async function locatePackageBin(packageName: string, notes: string[]): Promise<string | null> {
  const roots = [process.cwd(), ...(await pkgParentDirs())];
  for (const from of roots) {
    const require2 = createRequire(path.join(from, '__lens_resolvers.js'));
    const pkgRoot = await resolvePackageRoot(require2, packageName, notes);
    if (!pkgRoot) continue;
    const binDir = path.join(pkgRoot, 'bin');
    if (await pathExists(binDir)) {
      notes.push(`Found ${packageName} at ${pkgRoot}.`);
      return binDir;
    }
    notes.push(`${packageName} resolved to ${pkgRoot} but has no bin directory.`);
  }
  notes.push(`${packageName} is not installed in this project.`);
  return null;
}

/**
 * Locate a dependency's package directory.
 *
 * `require.resolve('<pkg>/package.json')` is the direct route, but packages that
 * publish an `exports` map without `./package.json` (for example
 * @sparticuz/chromium) reject it, so the fallback resolves the entry point and
 * walks up to the directory whose package.json declares the requested name.
 */
async function resolvePackageRoot(require2: NodeRequire, packageName: string, notes: string[]): Promise<string | null> {
  try {
    return path.dirname(require2.resolve(`${packageName}/package.json`));
  } catch {
    /* fall through to the entry-point walk */
  }
  try {
    let current = path.dirname(require2.resolve(packageName));
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = path.join(current, 'package.json');
      if (await pathExists(candidate)) {
        const manifest = await readJsonOpt<{ name?: string }>(candidate);
        if (manifest?.name === packageName) return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch (err) {
    notes.push(`${packageName} could not be resolved from ${process.cwd()}: ${(err as Error).message.split('\n')[0]}`);
  }
  return null;
}

/** node_modules may live above cwd in a workspace or global install. */
async function pkgParentDirs(): Promise<string[]> {
  const out: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    out.push(dir = parent);
  }
  return out;
}

async function fingerprintBinDir(binDir: string): Promise<string> {
  const entries = await fsp.readdir(binDir).catch(() => [] as string[]);
  const parts: string[] = [];
  for (const name of entries.sort()) {
    try {
      const stat = await fsp.stat(path.join(binDir, name));
      parts.push(`${name}:${stat.size}:${Math.round(stat.mtimeMs)}`);
    } catch {
      parts.push(`${name}:?`);
    }
  }
  return sha256(parts.join('|'));
}

function safeSegment(value: string): string {
  return value.replace(/^@/, '').replace(/[\\/]/g, '__').replace(/[^\w.-]/g, '_');
}

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}
