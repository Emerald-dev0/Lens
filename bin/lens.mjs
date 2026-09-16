#!/usr/bin/env node
/**
 * Lens CLI entry point.
 *
 * Thin on purpose: it prefers a compiled `dist`, and falls back to building once
 * when the repo has not been built yet. That keeps `git clone` → `node bin/lens.mjs`
 * usable without the user remembering a build step, which is the install path Lens
 * is designed around.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const compiled = path.join(repoRoot, 'dist', 'cli', 'index.js');

if (existsSync(compiled) || process.env.LENS_SKIP_BUILD === '1') {
  if (!existsSync(compiled)) {
    process.stderr.write(`Lens: ${path.relative(repoRoot, compiled)} is missing. Run \`npm run build\`.\n`);
    process.exit(1);
  }
  await import(pathToFileURL(compiled).href);
} else {
  const tsEntry = path.join(repoRoot, 'src', 'cli', 'index.ts');
  if (!existsSync(tsEntry)) {
    process.stderr.write('Lens: no build found (dist/cli/index.js) and no src/cli/index.ts to build from.\n');
    process.exit(1);
  }
  process.stderr.write('Lens: building for the first time (one-off, ~2s)…\n');
  const tsc = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const build = spawn(tsc, ['-p', 'tsconfig.build.json'], { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  build.on('error', (err) => {
    process.stderr.write(`Lens could not invoke the TypeScript compiler: ${err.message}\n`);
    process.exit(1);
  });
  build.on('exit', (code) => {
    if (code !== 0) {
      process.stderr.write('Lens: build failed. Run `npm run build` to see the errors.\n');
      process.exit(code ?? 1);
    }
    import(pathToFileURL(compiled).href).catch((err) => {
      process.stderr.write(`Lens failed to start: ${err.message}\n`);
      process.exit(1);
    });
  });
}
