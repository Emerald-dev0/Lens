/**
 * Project detection.
 *
 * Lens never hard-codes a framework. It reads the repository, infers how to talk
 * to the running app, and reports its reasoning — so failure messages can say
 * "this looks like a Vite app, start it with `npm run dev`" instead of "ECONNREFUSED".
 */
import fs from 'node:fs';
import path from 'node:path';

import { isFileSync, pathExistsSync, readTextOptSync, safeName } from '../util/fs.js';

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno' | 'nix' | 'unknown';

export interface ScriptInfo {
  name: string;
  command: string;
}

export interface ProjectProfile {
  root: string;
  name: string | null;
  kind: 'web-app' | 'static-site' | 'non-web' | 'unknown';
  framework: { id: string; label: string; version?: string; source: string } | null;
  renderer: 'csr' | 'ssr' | 'ssg' | 'unknown';
  languages: string[];
  packageManager: PackageManagerName;
  lockfiles: string[];
  scripts: ScriptInfo[];
  devCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  testCommand: string | null;
  likelyPorts: number[];
  /** Ports explicitly configured in framework config files. */
  configuredPort: number | null;
  configFiles: string[];
  entryCandidates: string[];
  staticHtmlFiles: string[];
  /** e.g. `src/app`, `app`, `pages`, `docs` */
  routeRoots: string[];
  hasGitignore: boolean;
  notes: string[];
  detectedAt: string;
}

interface FrameworkRule {
  id: string;
  label: string;
  /** package.json dependency keys to look for. */
  deps: string[];
  /** file markers (relative globs, matched by name only). */
  files?: string[];
  defaultPorts: number[];
  devCommand?: string;
  renderer?: ProjectProfile['renderer'];
  configPortPatterns?: RegExp[];
}

export const FRAMEWORK_RULES: FrameworkRule[] = [
  {
    id: 'next',
    label: 'Next.js',
    deps: ['next'],
    files: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
    defaultPorts: [3000],
    renderer: 'ssr',
    configPortPatterns: [/port\s*:\s*(\d{2,5})/],
  },
  {
    id: 'nuxt',
    label: 'Nuxt',
    deps: ['nuxt', 'nuxt3', 'nuxt-edge'],
    files: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'],
    defaultPorts: [3000],
    renderer: 'ssr',
    configPortPatterns: [/port\s*:\s*['"`]?(\d{2,5})/],
  },
  {
    id: 'remix',
    label: 'Remix',
    deps: ['@remix-run/node', '@remix-run/dev', '@remix-run/react'],
    defaultPorts: [5173, 3000],
    renderer: 'ssr',
  },
  {
    id: 'react-router',
    label: 'React Router (framework mode)',
    deps: ['@react-router/dev', 'react-router-dom'],
    defaultPorts: [5173],
  },
  {
    id: 'astro',
    label: 'Astro',
    deps: ['astro'],
    files: ['astro.config.mjs', 'astro.config.ts'],
    defaultPorts: [4321],
    renderer: 'ssg',
    configPortPatterns: [/port\s*:\s*(\d{2,5})/],
  },
  {
    id: 'sveltekit',
    label: 'SvelteKit',
    deps: ['@sveltejs/kit'],
    files: ['svelte.config.js', 'svelte.config.mjs'],
    defaultPorts: [5173],
    renderer: 'ssr',
  },
  {
    id: 'svelte',
    label: 'Svelte (Vite)',
    deps: ['svelte'],
    defaultPorts: [5173],
  },
  {
    id: 'vite-react',
    label: 'Vite + React',
    deps: ['vite', 'react'],
    defaultPorts: [5173],
    renderer: 'csr',
  },
  {
    id: 'vite-vue',
    label: 'Vite + Vue',
    deps: ['vite', 'vue'],
    defaultPorts: [5173],
    renderer: 'csr',
  },
  {
    id: 'vite',
    label: 'Vite',
    deps: ['vite'],
    files: ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'],
    defaultPorts: [5173],
    renderer: 'csr',
    configPortPatterns: [/port\s*:\s*(\d{2,5})/],
  },
  {
    id: 'nuxt-alt',
    label: 'Nuxt (legacy)',
    deps: ['nuxt'],
    defaultPorts: [3000],
  },
  {
    id: 'angular',
    label: 'Angular',
    deps: ['@angular/core'],
    files: ['angular.json'],
    defaultPorts: [4200],
    configPortPatterns: [/"port"\s*:\s*(\d{2,5})/],
  },
  {
    id: 'cra',
    label: 'Create React App',
    deps: ['react-scripts'],
    defaultPorts: [3000],
  },
  {
    id: 'gatsby',
    label: 'Gatsby',
    deps: ['gatsby'],
    defaultPorts: [8000],
    renderer: 'ssg',
  },
  {
    id: 'eleventy',
    label: 'Eleventy',
    deps: ['@11ty/eleventy'],
    defaultPorts: [8080],
    renderer: 'ssg',
  },
  {
    id: 'parcel',
    label: 'Parcel',
    deps: ['parcel', '@parcel/core'],
    defaultPorts: [1234],
  },
  {
    id: 'webpack',
    label: 'Webpack dev server',
    deps: ['webpack', 'webpack-dev-server'],
    defaultPorts: [8080],
    configPortPatterns: [/port\s*:\s*['"`]?(\d{2,5})/],
  },
  {
    id: 'solid-start',
    label: 'SolidStart',
    deps: ['@solidjs/start', 'solid-js'],
    defaultPorts: [3000],
  },
  {
    id: 'django',
    label: 'Django',
    deps: [],
    files: ['manage.py'],
    defaultPorts: [8000],
    devCommand: 'python manage.py runserver',
  },
  {
    id: 'flask',
    label: 'Flask',
    deps: [],
    files: ['app.py', 'wsgi.py'],
    defaultPorts: [5000],
    devCommand: 'flask run',
  },
  {
    id: 'rails',
    label: 'Rails',
    deps: [],
    files: ['config.ru', 'Gemfile'],
    defaultPorts: [3000],
    devCommand: 'bin/rails server',
  },
  {
    id: 'laravel',
    label: 'Laravel',
    deps: [],
    files: ['artisan', 'composer.json'],
    defaultPorts: [8000],
    devCommand: 'php artisan serve',
  },
  {
    id: 'go',
    label: 'Go server',
    deps: [],
    files: ['go.mod', 'main.go'],
    defaultPorts: [8080],
    devCommand: 'go run .',
  },
  {
    id: 'vitepress',
    label: 'VitePress docs',
    deps: ['vitepress'],
    defaultPorts: [5173],
    renderer: 'ssg',
  },
];

const FRAMEWORK_DEP_NAMES = new Set(['react', 'vue', 'svelte', 'preact', 'solid-js', 'angular', 'next', 'astro', 'nuxt', '@angular/core']);

export interface DetectOptions {
  /** Directory to detect within. Defaults to cwd. */
  cwd?: string;
  /** Extra port to consider first (from CLI `--port`). */
  preferPort?: number;
}

export async function detectProject(options: DetectOptions = {}): Promise<ProjectProfile> {
  const root = path.resolve(options.cwd ?? process.cwd());
  const notes: string[] = [];

  const pkgPath = path.join(root, 'package.json');
  const pkg = readJsonSafe(pkgPath) as
    | {
        name?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        engines?: Record<string, string>;
        packageManager?: string;
      }
    | null;

  if (!pkg && !hasAnyWebMarker(root)) {
    notes.push('No package.json and no recognizable web/server entry points were found.');
  }

  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const depNames = Object.keys(deps);

  const framework = matchFramework(root, depNames, notes);

  const scripts = Object.entries(pkg?.scripts ?? {}).map(([name, command]) => ({ name, command }));
  const lockfiles = detectLockfiles(root);
  const packageManager = detectPackageManager(root, pkg?.packageManager, lockfiles);

  const devCommand = pickDevCommand(scripts, framework, packageManager, notes);
  const buildCommand = pickCommand(scripts, ['build', 'compile', 'dist']) ?? framework?.devCommand ?? null;
  const startCommand = pickCommand(scripts, ['start', 'serve', 'preview']) ?? null;
  const testCommand = pickCommand(scripts, ['test', 'test:e2e', 'vitest', 'e2e']) ?? null;

  const configuredPort = framework ? readConfiguredPort(root, framework) : readVitePort(root);
  const envPort = readEnvPort(root);
  const scriptPortCommand = scripts.find((entry) => /--port[= ]\d{2,5}/.test(entry.command));
  const scriptPort = scriptPortCommand ? Number(/--port[= ](\d{2,5})/.exec(scriptPortCommand.command)?.[1]) : undefined;
  const likelyPorts = uniqueNumbers([
    options.preferPort,
    envPort,
    configuredPort,
    scriptPort,
    ...(framework?.defaultPorts ?? []),
    5173,
    3000,
    4321,
    8080,
  ]);

  const staticHtmlFiles = findStaticHtml(root);
  const entryCandidates = findEntryCandidates(root, framework?.id);

  const kind: ProjectProfile['kind'] = framework
    ? 'web-app'
    : staticHtmlFiles.length > 0
      ? 'static-site'
      : depNames.some((d) => FRAMEWORK_DEP_NAMES.has(d))
        ? 'web-app'
        : pkg
          ? 'non-web'
          : 'unknown';

  const routeRoots = findRouteRoots(root);

  return {
    root,
    name: pkg?.name ?? path.basename(root),
    kind,
    framework: framework ? { id: framework.id, label: framework.label, version: deps[frameworkDepKey(deps, framework)]?.replace(/^[\^~]/, ''), source: 'package.json' } : null,
    renderer: framework?.renderer ?? (routeRoots.length ? 'ssr' : 'unknown'),
    languages: detectLanguages(root, depNames),
    packageManager,
    lockfiles,
    scripts,
    devCommand,
    buildCommand,
    startCommand,
    testCommand,
    likelyPorts,
    configuredPort: configuredPort ?? envPort,
    configFiles: findConfigFiles(root),
    entryCandidates,
    staticHtmlFiles,
    routeRoots,
    hasGitignore: pathExistsSync(path.join(root, '.gitignore')),
    notes,
    detectedAt: new Date().toISOString(),
  };
}

function matchFramework(root: string, depNames: string[], notes: string[]): FrameworkRule | null {
  const depSet = new Set(depNames);
  const sorted = [...FRAMEWORK_RULES].sort((a, b) => b.deps.length - a.deps.length);
  for (const rule of sorted) {
    if (rule.deps.length && rule.deps.every((d) => depSet.has(d))) {
      notes.push(`Framework inferred from dependencies: ${rule.deps.join(' + ')}.`);
      return rule;
    }
  }
  for (const rule of sorted) {
    if (!rule.files?.length) continue;
    if (rule.files.some((f) => pathExistsSync(path.join(root, f)))) {
      notes.push(`Framework inferred from config file: ${rule.files.find((f) => pathExistsSync(path.join(root, f)))}.`);
      return rule;
    }
  }
  return null;
}

function frameworkDepKey(deps: Record<string, string>, framework: FrameworkRule): string {
  return framework.deps.find((d) => deps[d] !== undefined) ?? framework.deps[0] ?? '';
}

function detectLockfiles(root: string): string[] {
  const candidates = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'deno.json', 'deno.lock'];
  return candidates.filter((f) => pathExistsSync(path.join(root, f)));
}

function detectPackageManager(root: string, packageManagerField: string | undefined, lockfiles: string[]): PackageManagerName {
  if (packageManagerField) {
    const match = /^(npm|pnpm|yarn|bun|deno)[@/]/.exec(packageManagerField);
    if (match?.[1]) return match[1] as PackageManagerName;
  }
  if (lockfiles.includes('pnpm-lock.yaml')) return 'pnpm';
  if (lockfiles.includes('yarn.lock')) return 'yarn';
  if (lockfiles.includes('bun.lockb') || lockfiles.includes('bun.lock')) return 'bun';
  if (lockfiles.includes('deno.json') || lockfiles.includes('deno.lock')) return 'deno';
  if (lockfiles.includes('package-lock.json')) return 'npm';
  if (pathExistsSync(path.join(root, 'flake.nix')) || pathExistsSync(path.join(root, 'shell.nix'))) return 'nix';
  return 'unknown';
}

function pickDevCommand(
  scripts: ScriptInfo[],
  framework: FrameworkRule | null,
  packageManager: PackageManagerName,
  notes: string[],
): string | null {
  const direct = pickCommand(scripts, ['dev', 'develop', 'start:dev', 'watch', 'serve']);
  if (direct) {
    const runner = packageManager === 'unknown' ? 'npm' : packageManager;
    notes.push(`Dev command taken from package.json script "dev" (run with \`${runner} run dev\`).`);
    return direct;
  }
  if (framework?.devCommand) return framework.devCommand;
  if (framework?.id === 'next') return 'dev';
  if (framework?.id.startsWith('vite')) return 'dev';
  return null;
}

function pickCommand(scripts: ScriptInfo[], candidates: string[]): string | null {
  for (const name of candidates) {
    const found = scripts.find((s) => s.name === name);
    if (found?.command) return found.command;
  }
  return null;
}

function readConfiguredPort(root: string, framework: FrameworkRule): number | null {
  const files: string[] = [];
  if (framework.id.startsWith('vite')) files.push('vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts');
  if (framework.id === 'next') files.push('next.config.js', 'next.config.mjs', 'next.config.ts');
  if (framework.id === 'astro') files.push('astro.config.mjs', 'astro.config.ts');
  if (framework.id === 'nuxt') files.push('nuxt.config.ts', 'nuxt.config.js');
  if (framework.id === 'angular') files.push('angular.json');
  if (framework.id === 'webpack') files.push('webpack.config.js', 'webpack.config.ts');
  for (const file of files) {
    const text = readTextOptSync(path.join(root, file));
    if (!text) continue;
    for (const re of framework.configPortPatterns ?? [/port\s*:\s*(\d{2,5})/]) {
      const m = re.exec(text);
      const port = m?.[1] ? Number(m[1]) : NaN;
      if (Number.isFinite(port) && port > 0 && port < 65_536) return port;
    }
  }
  return null;
}

function readVitePort(root: string): number | null {
  for (const file of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
    const text = readTextOptSync(path.join(root, file));
    if (!text) continue;
    const m = /port\s*:\s*(\d{2,5})/.exec(text);
    const port = m?.[1] ? Number(m[1]) : NaN;
    if (Number.isFinite(port) && port > 0 && port < 65_536) return port;
  }
  return null;
}

function readEnvPort(root: string): number | null {
  for (const file of ['.env.local', '.env']) {
    const text = readTextOptSync(path.join(root, file));
    if (!text) continue;
    const m = /^(?:VITE_PORT|PORT|HOST_PORT)\s*=\s*"?(\d{2,5})"?/m.exec(text);
    const port = m?.[1] ? Number(m[1]) : NaN;
    if (Number.isFinite(port) && port > 0 && port < 65_536) return port;
  }
  return null;
}

function findStaticHtml(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.svelte-kit', '.output', 'coverage', '.lens']);
  const queue = [root];
  let visited = 0;
  while (queue.length && out.length < 12 && visited < 900) {
    const dir = queue.shift() as string;
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !entry.name.startsWith('.')) queue.push(full);
      } else if (entry.name.endsWith('.html') && isFileSync(full)) {
        out.push(relTo(root, full));
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function findEntryCandidates(root: string, frameworkId?: string): string[] {
  const candidates = [
    'index.html',
    'src/main.tsx',
    'src/main.ts',
    'src/main.js',
    'src/App.tsx',
    'src/app/page.tsx',
    'app/page.tsx',
    'pages/index.tsx',
    'src/routes/+page.svelte',
    'src/pages/index.tsx',
    'src/index.tsx',
    'public/index.html',
  ];
  if (frameworkId === 'next') candidates.unshift('src/app/layout.tsx', 'app/layout.tsx');
  return candidates.filter((c) => pathExistsSync(path.join(root, c)));
}

function findRouteRoots(root: string): string[] {
  const candidates = ['src/app', 'app', 'pages', 'src/pages', 'src/routes', 'routes'];
  return candidates.filter((c) => {
    try {
      return fs.statSync(path.join(root, c)).isDirectory();
    } catch {
      return false;
    }
  });
}

function findConfigFiles(root: string): string[] {
  const files = [
    'lens.config.json',
    '.lensrc.json',
    'lens.config.mjs',
    'package.json',
    'vite.config.ts',
    'vite.config.js',
    'next.config.js',
    'next.config.mjs',
    'astro.config.mjs',
    'svelte.config.js',
    'nuxt.config.ts',
    'angular.json',
    'tsconfig.json',
    'tailwind.config.js',
    'playwright.config.ts',
    '.env',
  ];
  return files.filter((f) => pathExistsSync(path.join(root, f)));
}

function detectLanguages(root: string, depNames: string[]): string[] {
  const out = new Set<string>();
  if (depNames.length) out.add('typescript/javascript');
  const files = ['tsconfig.json', 'vite.config.ts', 'next.config.mjs'];
  if (files.some((f) => pathExistsSync(path.join(root, f)))) out.add('typescript');
  if (pathExistsSync(path.join(root, 'requirements.txt')) || pathExistsSync(path.join(root, 'pyproject.toml'))) out.add('python');
  if (pathExistsSync(path.join(root, 'go.mod'))) out.add('go');
  if (pathExistsSync(path.join(root, 'Cargo.toml'))) out.add('rust');
  if (pathExistsSync(path.join(root, 'Gemfile'))) out.add('ruby');
  if (pathExistsSync(path.join(root, 'composer.json'))) out.add('php');
  return [...out];
}

function hasAnyWebMarker(root: string): boolean {
  const markers = ['package.json', 'index.html', 'manage.py', 'go.mod', 'Gemfile', 'composer.json', 'Cargo.toml', 'config.ru'];
  return markers.some((m) => pathExistsSync(path.join(root, m)));
}

function readJsonSafe(file: string): unknown {
  const text = readTextOptSync(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function relTo(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function uniqueNumbers(values: Array<number | null | undefined>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 65_535 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Actionable hints for "I could not reach the app" style failures. */
export function devServerHints(profile: ProjectProfile | null, port: number | null): string[] {
  const hints: string[] = [];
  if (!profile) {
    hints.push('No package.json was found here — run Lens from the application project root, or pass --project <dir>.');
    hints.push('Open an explicit URL instead of a port: `lens open http://localhost:5173`.');
    return hints;
  }
  if (profile.devCommand) {
    const runner = profile.packageManager === 'unknown' ? 'npm' : profile.packageManager;
    const cmd = /^(npm|pnpm|yarn|bun|deno)\s/.test(profile.devCommand)
      ? profile.devCommand
      : `${runner} run ${profile.devCommand.replace(/^run\s+/, '')}`;
    hints.push(`Start the development server with the project's configured dev command: \`${cmd}\`.`);
  } else if (profile.scripts.length) {
    hints.push(`No dev script was found. Available: ${profile.scripts.map((s) => s.name).slice(0, 8).join(', ')}.`);
  } else {
    hints.push('The project has no package.json scripts; start the server yourself and pass its URL.');
  }
  if (port) hints.push(`If the server listens elsewhere, pass it explicitly: \`lens open http://localhost:<port>\`.`);
  if (profile.likelyPorts.length > 1) {
    hints.push(`Ports considered: ${profile.likelyPorts.slice(0, 6).join(', ')}.`);
  }
  if (profile.framework) hints.push(`Framework: ${profile.framework.label}${profile.framework.version ? ` v${profile.framework.version}` : ''}.`);
  return hints;
}
