/**
 * Accessibility snapshots — Lens's "eyes".
 *
 * The snapshot is the primary way an agent understands a page: a compact ARIA tree
 * where every meaningful node carries a `ref`. That ref is directly actionable
 * (`aria-ref=e12`), which is why Lens does not need to guess coordinates.
 *
 * Screenshots answer "how does it look"; this answers "what is it".
 */
import type { Page } from 'playwright-core';

import type { LensConfig } from '../config/schema.js';
import { LensError, LensErrorCode } from '../errors.js';
import { maybeRedact } from '../security/redact.js';

export interface SnapshotNode {
  role: string;
  name?: string;
  text?: string;
  ref?: string;
  level?: number;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  active?: boolean;
  invalid?: boolean;
  pressed?: boolean | 'mixed';
  url?: string;
  placeholder?: string;
  value?: string;
  cursor?: string;
  box?: { x: number; y: number; width: number; height: number };
  children?: Array<SnapshotNode | string>;
}

export interface InteractiveElement {
  ref: string;
  role: string;
  name?: string;
  /** Element value/state where meaningful. */
  value?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  invalid?: boolean;
  placeholder?: string;
  url?: string;
  level?: number;
  box: { x: number; y: number; width: number; height: number };
  /** Center point, for the coordinate fallback only. */
  center: { x: number; y: number };
  /** Whether the node is inside the current viewport. */
  inViewport: boolean;
  /** `cursor: pointer` on a non-interactive role is a strong clickability hint. */
  clickable: boolean;
  /** DOM path captured at snapshot time for staleness recovery. */
  domHint?: string;
}

export interface SnapshotOptions {
  /** Max tree depth (undefined = unlimited). */
  depth?: number;
  /** Restrict to a subtree via CSS selector. */
  root?: string;
  /** Include `[box=…]` annotations. */
  boxes?: boolean;
  /** Cap emitted lines; `0` disables. */
  maxLines?: number;
  /** Exclude generic containers with no name (denser, default for agents). */
  interestingOnly?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number; scrollHeight: number; scrollWidth: number };
  /** Monotonic id for this page's snapshots; refs belong to a generation. */
  generation: number;
  tree: SnapshotNode[];
  text: string;
  elements: InteractiveElement[];
  counts: { nodes: number; interactive: number; byRole: Record<string, number> };
  truncated: boolean;
  takenAt: string;
  /** Document title + `<h1>`s, handy for orientation in long flows. */
  headings: string[];
  documentSize: { width: number; height: number };
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
  'row',
  'gridcell',
  'columnheader',
  'rowheader',
  'application',
  'dialog',
  'alertdialog',
  'search',
  'form',
]);

export class SnapshotService {
  private generation = 0;

  constructor(private readonly config: LensConfig) {}

  async capture(page: Page, options: SnapshotOptions = {}): Promise<PageSnapshot> {
    this.generation += 1;
    const generation = this.generation;

    const raw = await this.captureAria(page, options);
    const tree = normalizeNodes(raw);
    const elements = collectInteractive(tree, {
      viewport: { width: 0, height: 0 },
      generation,
    });

    const meta = await page
      .evaluate(() => {
        const de = document.documentElement;
        return {
          url: location.href,
          title: document.title,
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          scrollHeight: de ? de.scrollHeight : 0,
          scrollWidth: de ? de.scrollWidth : 0,
          headings: [...document.querySelectorAll('h1, h2')].slice(0, 12).map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
          documentWidth: de ? de.clientWidth : 0,
          documentHeight: de ? de.clientHeight : 0,
        };
      })
      .catch(() => ({
        url: page.url(),
        title: '',
        width: 0,
        height: 0,
        scrollX: 0,
        scrollY: 0,
        scrollHeight: 0,
        scrollWidth: 0,
        headings: [] as string[],
        documentWidth: 0,
        documentHeight: 0,
      }));

    for (const element of elements) {
      element.inViewport =
        element.box.y + element.box.height > 0 &&
        element.box.y < meta.height &&
        element.box.x + element.box.width > 0 &&
        element.box.x < meta.width;
    }

    const text = renderTree(tree, {
      boxes: options.boxes ?? false,
      interestingOnly: options.interestingOnly ?? true,
      maxLines: options.maxLines ?? 400,
      redact: (value) => maybeRedact(this.config, value).value,
    });

    const byRole: Record<string, number> = {};
    let nodes = 0;
    const countWalk = (list: SnapshotNode[]): void => {
      for (const node of list) {
        nodes += 1;
        byRole[node.role] = (byRole[node.role] ?? 0) + 1;
        if (node.children) countWalk(node.children.filter((c): c is SnapshotNode => typeof c !== 'string'));
      }
    };
    countWalk(tree);

    return {
      url: meta.url,
      title: meta.title,
      viewport: { width: meta.width, height: meta.height },
      scroll: { x: meta.scrollX, y: meta.scrollY, scrollHeight: meta.scrollHeight, scrollWidth: meta.scrollWidth },
      generation,
      tree,
      text: text.text,
      elements,
      counts: { nodes, interactive: elements.length, byRole },
      truncated: text.truncated,
      takenAt: new Date().toISOString(),
      headings: meta.headings,
      documentSize: { width: meta.documentWidth, height: meta.documentHeight },
    };
  }

  /**
   * The ARIA tree comes from Playwright's own accessibility implementation — the
   * same data a screen reader uses. Older drivers expose only the YAML form; both
   * are handled so a snapshot never becomes a hard dependency on a new API.
   */
  private async captureAria(page: Page, options: SnapshotOptions): Promise<SnapshotNode[]> {
    const locator = options.root ? page.locator(options.root).first() : page.locator('body');
    try {
      const target = locator as unknown as {
        ariaSnapshotJSON?: (o: { mode?: 'ai' | 'default'; boxes?: boolean; depth?: number; timeout?: number }) => Promise<unknown>;
        ariaSnapshot?: (o: { mode?: 'ai' | 'default'; boxes?: boolean; depth?: number; timeout?: number }) => Promise<string>;
      };
      if (typeof target.ariaSnapshotJSON === 'function') {
        const value = await target.ariaSnapshotJSON({
          mode: 'ai',
          boxes: true,
          ...(options.depth ? { depth: options.depth } : {}),
          timeout: this.config.defaults.actionTimeoutMs,
        });
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? (parsed as SnapshotNode[]) : [parsed as SnapshotNode];
      }
      if (typeof target.ariaSnapshot === 'function') {
        const yaml = await target.ariaSnapshot({
          boxes: true,
          ...(options.depth ? { depth: options.depth } : {}),
          timeout: this.config.defaults.actionTimeoutMs,
        });
        return parseAriaYaml(yaml);
      }
    } catch (err) {
      throw new LensError({
        code: LensErrorCode.REVIEW_FAILED,
        message: 'The accessibility snapshot failed.',
        scope: 'browser',
        detail: (err as Error).message.split('\n')[0],
        hints: [
          'A heavy page may have exceeded the snapshot timeout — retry with --depth 6 or a --root selector.',
          'Fall back to structural inspection with `lens elements` if it keeps failing.',
        ],
        cause: err,
      });
    }
    throw new LensError({
      code: LensErrorCode.ACTION_UNSUPPORTED,
      message: 'This Playwright version cannot produce ARIA snapshots.',
      scope: 'environment',
      hints: ['Upgrade playwright-core to >= 1.49, which introduced ariaSnapshot.'],
    });
  }
}

interface CollectContext {
  viewport: { width: number; height: number };
  generation: number;
}

function normalizeNodes(nodes: unknown): SnapshotNode[] {
  if (!Array.isArray(nodes)) return [];
  const out: SnapshotNode[] = [];
  for (const raw of nodes) {
    if (typeof raw === 'string') continue;
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as Record<string, unknown>;
    const role = typeof node.role === 'string' ? node.role : 'generic';
    const normalized: SnapshotNode = { role };
    for (const key of ['name', 'text', 'ref', 'placeholder', 'url', 'value', 'cursor', 'description', 'error-message'] as const) {
      const value = (node as Record<string, unknown>)[key as string];
      if (typeof value === 'string' && value.length) (normalized as unknown as Record<string, unknown>)[key] = value;
    }
    for (const key of ['checked', 'disabled', 'expanded', 'selected', 'active', 'invalid', 'pressed', 'required', 'multiselectable'] as const) {
      const value = (node as Record<string, unknown>)[key as string];
      if (typeof value === 'boolean' || value === 'mixed') (normalized as unknown as Record<string, unknown>)[key] = value;
    }
    if (typeof node.level === 'number') normalized.level = node.level;
    if (node.box && typeof node.box === 'object') normalized.box = node.box as SnapshotNode['box'];
    const children = node.children;
    if (Array.isArray(children) && children.length) {
      normalized.children = children.filter((c) => typeof c === 'string' || (c && typeof c === 'object')) as SnapshotNode['children'];
    }
    out.push(normalized);
  }
  return out;
}

function collectInteractive(nodes: SnapshotNode[], context: CollectContext): InteractiveElement[] {
  const out: InteractiveElement[] = [];
  const walk = (list: SnapshotNode[]): void => {
    for (const node of list) {
      const interactive = isInteractive(node);
      if (interactive && node.ref && node.box) {
        const element: InteractiveElement = {
          ref: node.ref,
          role: node.role,
          box: node.box,
          center: { x: Math.round(node.box.x + node.box.width / 2), y: Math.round(node.box.y + node.box.height / 2) },
          inViewport: true,
          clickable: node.cursor === 'pointer' || INTERACTIVE_ROLES.has(node.role),
        };
        for (const key of ['name', 'value', 'placeholder', 'url', 'level', 'checked', 'disabled', 'expanded', 'selected', 'invalid', 'pressed', 'required'] as const) {
          const value = (node as unknown as Record<string, unknown>)[key];
          if (typeof value === 'string' && value.length) (element as unknown as Record<string, unknown>)[key] = value;
          else if (typeof value === 'number' || typeof value === 'boolean') (element as unknown as Record<string, unknown>)[key] = value;
        }
        out.push(element);
      }
      if (node.children) walk(node.children.filter((c): c is SnapshotNode => typeof c !== 'string'));
    }
  };
  walk(nodes);
  void context;
  return out;
}

function isInteractive(node: SnapshotNode): boolean {
  if (INTERACTIVE_ROLES.has(node.role)) return true;
  if (node.role === 'generic' && node.cursor === 'pointer') return true;
  return false;
}

interface RenderOptions {
  boxes: boolean;
  interestingOnly: boolean;
  maxLines: number;
  redact: (value: string) => string;
}

interface RenderResult {
  text: string;
  truncated: boolean;
}

/** Render the ARIA tree as compact, ref-bearing lines for agents. */
export function renderTree(nodes: SnapshotNode[], options: RenderOptions): RenderResult {
  const lines: string[] = [];
  let truncated = false;

  const push = (depth: number, text: string): boolean => {
    if (options.maxLines && lines.length >= options.maxLines) {
      truncated = true;
      return false;
    }
    lines.push(`${'  '.repeat(depth)}${text}`);
    return true;
  };

  const walk = (list: SnapshotNode[], depth: number): void => {
    for (const node of list) {
      const named = node.name ?? node.text;
      const interesting = node.ref !== undefined || INTERACTIVE_ROLES.has(node.role) || named || node.role !== 'generic';
      if (options.interestingOnly && node.role === 'generic' && !named && !node.ref) {
        if (node.children) walk(node.children.filter((c): c is SnapshotNode => typeof c !== 'string'), depth);
        continue;
      }
      if (interesting) {
        const parts = [node.role];
        if (named) parts.push(`"${options.redact(oneLine(named)).slice(0, 120)}"`);
        const state = stateFlags(node);
        if (state) parts.push(state);
        if (node.ref) parts.push(`[ref=${node.ref}]`);
        if (options.boxes && node.box) parts.push(`[box=${round(node.box.x)},${round(node.box.y)} ${round(node.box.width)}x${round(node.box.height)}]`);
        if (!push(depth, `- ${parts.join(' ')}`)) return;
      }
      if (node.children) walk(node.children.filter((c): c is SnapshotNode => typeof c !== 'string'), interesting ? depth + 1 : depth);
    }
  };

  walk(nodes, 0);
  if (truncated) lines.push(`… truncated at ${options.maxLines} lines (re-run with --max-lines N or --depth)`);
  return { text: lines.join('\n'), truncated };
}

function stateFlags(node: SnapshotNode): string {
  const flags: string[] = [];
  const record = node as unknown as Record<string, unknown>;
  if (node.disabled) flags.push('disabled');
  if (record.checked === true || node.checked === true) flags.push('checked');
  else if (node.checked === 'mixed') flags.push('checked=mixed');
  if (node.expanded === true) flags.push('expanded');
  if (node.expanded === false) flags.push('collapsed');
  if (node.selected) flags.push('selected');
  if (node.invalid) flags.push('invalid');
  if (node.active) flags.push('focusable');
  if (typeof node.url === 'string') flags.push(`url=${shortUrl(node.url)}`);
  if (typeof node.placeholder === 'string' && node.placeholder && node.placeholder !== node.name) flags.push(`placeholder="${node.placeholder}"`);
  if (typeof node.level === 'number') flags.push(`level=${node.level}`);
  const value = record.value;
  if (typeof value === 'string' && value) flags.push(`value="${maskValue(node, value)}"`);
  if (record.required === true) flags.push('required');
  return flags.join(' ');
}

function maskValue(node: SnapshotNode, value: string): string {
  // A password textbox must never echo its content into an artifact.
  const name = `${node.name ?? ''}`.toLowerCase();
  if (name.includes('password') || name.includes('pin') || name.includes('cvv')) return '•'.repeat(Math.min(8, value.length));
  return value;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/' || parsed.pathname === '') return parsed.host;
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url.slice(0, 60);
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function round(value: number): number {
  return Math.round(value);
}

/**
 * Fallback YAML-ish parser for drivers without `ariaSnapshotJSON`.
 * Handles the `- role "name" [flag]` shape Playwright emits.
 */
export function parseAriaYaml(input: string): SnapshotNode[] {
  const root: SnapshotNode[] = [];
  const stack: Array<{ indent: number; node: SnapshotNode | null; list: SnapshotNode[] }> = [{ indent: -2, node: null, list: root }];
  for (const rawLine of input.split('\n')) {
    if (!rawLine.trim()) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (!line.startsWith('-')) continue;
    while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -2)) stack.pop();
    const body = line.replace(/^-\s*/, '').replace(/:\s*$/, '');
    const node = parseYamlNode(body);
    if (!node) continue;
    const parent = stack[stack.length - 1];
    if (parent) parent.list.push(node);
    stack.push({ indent, node, list: (node.children = node.children ?? []).filter((c): c is SnapshotNode => typeof c !== 'string') });
  }
  return root;
}

function parseYamlNode(body: string): SnapshotNode | null {
  const match = /^(?<role>[A-Za-z][\w-]*)(?:\s+"(?<name>[^"]*)")?(?<rest>.*)$/.exec(body.trim());
  if (!match?.groups) {
    const text = body.replace(/^text\s*/, '').trim();
    if (!text) return null;
    return { role: 'StaticText', name: text };
  }
  const node: SnapshotNode = { role: match.groups.role ?? 'generic' };
  if (match.groups.name) node.name = match.groups.name;
  const rest = match.groups.rest ?? '';
  const ref = /\[ref=([^\]]+)\]/.exec(rest)?.[1];
  if (ref) node.ref = ref;
  const box = /\[box=(-?[\d.]+),(-?[\d.]+) ([\d.]+)x([\d.]+)\]/.exec(rest);
  if (box) node.box = { x: Number(box[1]), y: Number(box[2]), width: Number(box[3]), height: Number(box[4]) };
  if (/\[disabled\]/.test(rest)) node.disabled = true;
  if (/\[checked\]/.test(rest)) node.checked = true;
  if (/\[expanded\]/.test(rest)) node.expanded = true;
  if (/\[selected\]/.test(rest)) node.selected = true;
  const level = /\[level=(\d+)\]/.exec(rest)?.[1];
  if (level) node.level = Number(level);
  const url = /\[url=([^\]]+)\]/.exec(rest)?.[1];
  if (url) node.url = url;
  const placeholder = /\[placeholder="([^"]*)"\]/.exec(rest)?.[1];
  if (placeholder) node.placeholder = placeholder;
  return node;
}
