/**
 * Flow loading.
 *
 * Flows are data, so they should live next to the project they test — either in
 * `lens.config.json` (inline) or as `.flow.json` files in `.lens/flows` or
 * `tests/lens`. JSON with comments is accepted because agents write these by hand
 * as often as they generate them.
 */
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { ResolvedConfig } from '../config/load.js';
import { LensError, LensErrorCode } from '../errors.js';
import { ensureDir, readTextOpt, safeName } from '../util/fs.js';
import { flowSchema, type Flow } from './schema.js';

export interface DiscoveredFlow {
  name: string;
  file: string | null;
  flow: Flow;
  source: 'config' | 'file' | 'inline' | 'argument';
}

/** Strip line and block comments outside of strings, then parse as JSON. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    out += char;
  }
  // Trailing commas before } or ] are legal in JSONC and common in hand edits.
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new LensError({
      code: LensErrorCode.FLOW_INVALID,
      message: 'The flow file is not valid JSON.',
      scope: 'input',
      detail: (err as Error).message,
      hints: ['Check for a stray comma or an unescaped quote. `lens flow validate <file>` points at the offending step.'],
      cause: err,
    });
  }
}

export function validateFlow(value: unknown, origin: string): Flow {
  const result = flowSchema.safeParse(value);
  if (result.success) return annotateSteps(result.data);
  const issues = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issueMessage(issue)}`);
  throw new LensError({
    code: LensErrorCode.FLOW_INVALID,
    message: `The flow in ${origin} is not valid.`,
    scope: 'input',
    detail: issues.join('\n'),
    hints: [
      'A flow needs a name and at least one step: {"name":"onboarding","steps":[{"action":"click","target":"text=\\"Sign up\\""}]}',
      'Step actions: click, dblclick, hover, type, fill, press, select, check, uncheck, drag, scroll, focus, upload, navigate, wait, expect, screenshot, review, chapter, observe, note, set.',
      'Every step either has a `target` (what to touch) or an `expect` (what must be true).',
    ],
    data: { origin, issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
  });
}

function issueMessage(issue: z.ZodIssue): string {
  if (issue.code === 'unrecognized_keys') return `unknown key${(issue as { keys?: string[] }).keys?.length ? `: ${(issue as { keys: string[] }).keys.join(', ')}` : ''}`;
  if (issue.code === 'invalid_enum_value') return `expected one of ${(issue as { options?: string[] }).options?.join(', ') ?? 'a known value'}`;
  return issue.message;
}

/** Normalise shorthand so the runner only deals with one shape. */
function annotateSteps(flow: Flow): Flow {
  const fix = (step: Flow['steps'][number], index: number) => {
    const hasTarget = Boolean(step.target);
    const expectation = step.expect ?? step.assert;
    const action =
      step.action ??
      (hasTarget ? inferAction(step) : expectation ? 'expect' : step.screenshot || step.review ? 'screenshot' : step.chapter ? 'chapter' : step.vars ? 'set' : 'note');
    return {
      ...step,
      action,
      label: step.label ?? labelFor(step, action, index),
      expect: expectation,
      assert: undefined,
    };
  };
  const map = (steps: Flow['steps'] | undefined) => (steps ?? []).map((step, index) => fix(step, index));
  return {
    ...flow,
    steps: map(flow.steps) as Flow['steps'],
    before: flow.before?.length ? (map(flow.before) as Flow['before']) : undefined,
    after: flow.after?.length ? (map(flow.after) as Flow['after']) : undefined,
  };
}

function inferAction(step: Flow['steps'][number]): string {
  if (step.url) return 'navigate';
  if (step.files?.length) return 'upload';
  if (step.options?.length) return 'select';
  if (step.key) return 'press';
  if (step.direction) return 'scroll';
  if (step.to) return 'drag';
  if (step.text !== undefined) return 'fill';
  return 'click';
}

function labelFor(step: Flow['steps'][number], action: string | undefined, index: number): string {
  const verb = action ?? 'step';
  if (step.target) return `${verb} ${step.target}`;
  if (step.url) return `${verb} ${step.url}`;
  const expectation = step.expect ?? step.assert;
  if (expectation) {
    const keys = Object.keys(expectation);
    if (keys.length === 1 && keys[0]) {
      const key = keys[0];
      const value = (expectation as Record<string, unknown>)[key];
      return `expect ${key} ${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`;
    }
    return `expect ${keys.join(', ')}`;
  }
  return `${verb} #${index + 1}`;
}

/** Where Lens looks for flows, in priority order. */
export function flowSearchDirs(config: ResolvedConfig): string[] {
  return [
    path.resolve(config.root, config.flows.dir),
    path.resolve(config.root, '.lens/flows'),
    path.resolve(config.root, 'tests/lens'),
    path.resolve(config.root, 'lens/flows'),
  ].filter((dir, index, all) => all.indexOf(dir) === index);
}

export async function listFlows(config: ResolvedConfig): Promise<DiscoveredFlow[]> {
  const found = new Map<string, DiscoveredFlow>();
  for (const [name, raw] of Object.entries(config.flows.inline ?? {})) {
    try {
      found.set(name, { name, file: null, flow: validateFlow(withName(raw, name), `lens.config.json flows.${name}`), source: 'config' });
    } catch (err) {
      if (err instanceof LensError) {
        throw new LensError({
          code: LensErrorCode.FLOW_INVALID,
          message: `The inline flow "${name}" in lens.config.json is invalid.`,
          scope: 'input',
          detail: err.detail,
          hints: err.hints,
        });
      }
      throw err;
    }
  }
  for (const dir of flowSearchDirs(config)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((file) => /\.(flow\.json|json|jsonc)$/.test(file));
    } catch {
      continue;
    }
    for (const file of entries.sort()) {
      const full = path.join(dir, file);
      const text = fs.readFileSync(full, 'utf8');
      const name = path.basename(file).replace(/\.flow\.json$|\.jsonc?$|\.json$/, '');
      if (found.has(name)) continue;
      found.set(name, { name, file: full, flow: validateFlow(tagName(parseJsonc(text), name), full), source: 'file' });
    }
  }
  return [...found.values()];
}

function withName(raw: unknown, name: string): unknown {
  if (raw && typeof raw === 'object' && !('name' in raw)) return { name, ...(raw as Record<string, unknown>) };
  return raw;
}

function tagName(raw: unknown, name: string): unknown {
  if (raw && typeof raw === 'object' && !('name' in raw)) return { name, ...(raw as Record<string, unknown>) };
  return raw;
}

/**
 * Resolve a flow from `--flow <name|path|->`, config, or an inline JSON string.
 * `-` reads stdin, which is how an agent pipes a generated flow without touching
 * the filesystem.
 */
export async function resolveFlow(config: ResolvedConfig, spec: string | undefined, options: { writeIfMissing?: boolean } = {}): Promise<DiscoveredFlow> {
  if (!spec) {
    const all = await listFlows(config);
    if (all.length === 1) return all[0] as DiscoveredFlow;
    if (all.length > 1) {
      throw new LensError({
        code: LensErrorCode.FLOW_NOT_FOUND,
        message: 'Several flows are available; name the one you want.',
        scope: 'input',
        detail: all.map((f) => `  ${f.name}${f.file ? ` (${path.relative(config.root, f.file)})` : ' (from lens.config.json)'}`).join('\n'),
        hints: ['Run `lens flow list`, then `lens test --flow <name>`.'],
        data: { flows: all.map((f) => f.name) },
      });
    }
    throw new LensError({
      code: LensErrorCode.FLOW_NOT_FOUND,
      message: 'No flows found.',
      scope: 'input',
      detail: `Searched: ${flowSearchDirs(config).map((dir) => path.relative(config.root, dir) || '.').join(', ')}`,
      hints: [
        'Create `.lens/flows/smoke.flow.json` with {"name":"smoke","steps":[…]}, or',
        'pass one inline: `lens test --flow \'{"steps":[{"action":"expect","expect":{"text":"Dashboard"}}]}\'`',
        'or pipe it: `echo \'…\' | lens test --flow -`',
      ],
    });
  }

  if (spec === '-') {
    const text = fs.readFileSync(0, 'utf8');
    return { name: 'stdin', file: null, flow: validateFlow(parseJsonc(text), 'stdin'), source: 'argument' };
  }
  if (spec.trimStart().startsWith('{')) {
    return { name: 'inline', file: null, flow: validateFlow(parseJsonc(spec), 'inline argument'), source: 'argument' };
  }

  const direct = path.resolve(config.root, spec);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    const name = path.basename(direct).replace(/\.flow\.json$|\.jsonc?$|\.json$/, '');
    return { name, file: direct, flow: validateFlow(tagName(parseJsonc(fs.readFileSync(direct, 'utf8')), name), direct), source: 'file' };
  }

  const all = await listFlows(config);
  const match = all.find((entry) => entry.name === spec);
  if (match) return match;

  throw new LensError({
    code: LensErrorCode.FLOW_NOT_FOUND,
    message: `No flow named "${spec}".`,
    scope: 'input',
    detail: all.length ? `Known flows: ${all.map((entry) => entry.name).join(', ')}` : `Searched: ${flowSearchDirs(config).join(', ')}`,
    hints: all.length
      ? [`Create one at ${path.join(config.flows.dir, `${safeName(spec, 'flow')}.flow.json`)}, or fix the name.`]
      : [`Create ${path.join(config.flows.dir, `${safeName(spec, 'flow')}.flow.json`)}. \`lens flow init ${safeName(spec, 'flow')}\` writes a starter with sensible steps.`],
    data: { requested: spec, known: all.map((entry) => entry.name) },
  });
}

/** Write a starter flow so `lens test` is never blocked on syntax. */
export async function writeStarterFlow(config: ResolvedConfig, name: string, url: string | undefined): Promise<string> {
  const target = path.join(config.flows.dir, `${safeName(name, 'smoke')}.flow.json`);
  await ensureDir(path.dirname(target));
  const flow = {
    name,
    description: 'Starter journey written by `lens flow init`. Edit the steps to match your product.',
    startUrl: url ?? '/',
    steps: [
      { label: 'The app shell renders', expect: { visible: 'css=body', text: '' } },
      { label: 'No console errors on first paint', expect: { consoleClean: true, networkClean: true } },
      { label: 'Primary navigation is present', expect: { count: { target: 'role=link', gte: 1 } } },
      { action: 'screenshot', label: 'Landing state' },
    ],
  };
  await fs.promises.writeFile(target, `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
  return target;
}

export async function loadFlowText(file: string): Promise<string> {
  const text = await readTextOpt(file);
  if (text === null) throw new LensError({ code: LensErrorCode.FILE_NOT_FOUND, message: `Flow file not found: ${file}`, scope: 'input' });
  return text;
}
