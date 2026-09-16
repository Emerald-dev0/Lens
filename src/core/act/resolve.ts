/**
 * Target resolution.
 *
 * Lens resolves what an agent means into a concrete element, in a deliberate
 * order of preference:
 *
 *   1. accessibility ref (`e12`)            — precise, from the last snapshot
 *   2. semantic role + accessible name      — stable across DOM churn
 *   3. label / placeholder / test id        — what the app itself promises
 *   4. css or xpath selector                — the agent's own knowledge
 *   5. coordinates                          — last resort, always explicit
 *
 * When a ref no longer resolves (SPA re-render), Lens re-snapshots and re-acquires
 * it by role+name rather than failing, and reports that it did so.
 */
import type { Locator, Page } from 'playwright-core';

import type { InteractiveElement, PageSnapshot } from '../observe/snapshot.js';
import { LensError, LensErrorCode } from '../errors.js';
import { escapeRegExp, truncate } from '../util/text.js';
import { log } from '../util/log.js';

export type TargetSpec =
  | { kind: 'ref'; ref: string }
  | { kind: 'role'; role: string; name?: string; exact: boolean; nth?: number }
  | { kind: 'text'; text: string; exact: boolean; nth?: number }
  | { kind: 'label'; text: string; exact: boolean; nth?: number }
  | { kind: 'placeholder'; text: string; exact: boolean; nth?: number }
  | { kind: 'testid'; id: string }
  | { kind: 'css'; selector: string; nth?: number }
  | { kind: 'xpath'; expression: string }
  | { kind: 'coords'; x: number; y: number };

export type ResolvedTarget =
  | { kind: 'locator'; locator: Locator; description: string; via: string; element?: InteractiveElement; recovered: boolean; box?: ElementBox }
  | { kind: 'point'; x: number; y: number; description: string; via: 'coords'; recovered: false };

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResolveOptions {
  page: Page;
  /** The snapshot refs came from. May be stale by the time an action runs. */
  snapshot: PageSnapshot | null;
  /** Previously seen elements, used for stale-ref recovery. */
  registry?: Map<string, InteractiveElement>;
  /** Supplied by the session so recovery can re-snapshot on demand. */
  snapshotProvider?: () => Promise<PageSnapshot | null>;
  nth?: number;
  /** For role/text matching: require full equality. */
  exact?: boolean;
  allowCoordinateFallback?: boolean;
}

/** Parse the `lens` target grammar. Everything an agent can type is a string here. */
export function parseTarget(input: string, options: { nth?: number; exact?: boolean } = {}): TargetSpec {
  const raw = input.trim();
  if (!raw) {
    throw LensError.usage('An empty element target was provided.', [
      'Pass a ref from a snapshot (e.g. e12), role=button[name="Save"], css=#submit, text="Save", or 120,340 for coordinates.',
    ]);
  }

  // Bare ref: `e12`
  if (/^e\d+$/i.test(raw)) return { kind: 'ref', ref: raw.toLowerCase() };
  if (/^ref=/i.test(raw)) return { kind: 'ref', ref: raw.slice(4).trim() };

  let match = /^role=([a-zA-Z-]+)(?:\[(.*)\])?$/.exec(raw);
  if (match) {
    const role = match[1];
    const attrs = parseRoleAttributes(match[2] ?? '');
    return {
      kind: 'role',
      role: typeof role === 'string' ? role : 'generic',
      name: typeof attrs.name === 'string' ? attrs.name : undefined,
      exact: attrs.exact !== false,
      nth: typeof attrs.nth === 'number' ? attrs.nth : options.nth,
    };
  }

  if ((match = /^text:(?:"(.*)"|(.*)\??)$/.exec(raw))) {
    const value = (match[1] ?? match[2] ?? '').trim();
    return { kind: 'text', text: unquote(value), exact: !value.endsWith('?') && (options.exact ?? false), nth: options.nth };
  }
  if ((match = /^(?:"(.*)"|'(.*)')$/.exec(raw))) {
    const value = match[1] ?? match[2] ?? '';
    return { kind: 'text', text: value, exact: options.exact ?? true, nth: options.nth };
  }

  if ((match = /^label:(?:"(.*)"|(.*))$/.exec(raw))) return { kind: 'label', text: match[1] ?? match[2] ?? '', exact: options.exact ?? false, nth: options.nth };
  if ((match = /^placeholder:(?:"(.*)"|(.*))$/.exec(raw))) return { kind: 'placeholder', text: match[1] ?? match[2] ?? '', exact: options.exact ?? false, nth: options.nth };
  if ((match = /^(?:testid|tid|data-testid)=?(?:"(.*)"|(.*))$/.exec(raw))) return { kind: 'testid', id: match[1] ?? match[2] ?? '' };
  if ((match = /^xpath=(.+)$/.exec(raw))) return { kind: 'xpath', expression: match[1] ?? '' };

  // Coordinates: `120,340` or `120 340`
  const coords = /^(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)$/.exec(raw);
  if (coords) return { kind: 'coords', x: Number(coords[1]), y: Number(coords[2]) };

  // Anything else is a CSS selector.
  return { kind: 'css', selector: raw, nth: options.nth };
}

function parseRoleAttributes(source: string): Partial<Record<'name' | 'nth' | 'exact', string | number | boolean>> {
  const out: Record<string, string | number | boolean> = {};
  if (!source) return out;
  const re = /(\w+)=(?:"([^"]*)"|'([^']*)'|([^,\]]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const key = match[1] ?? '';
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (key === 'nth') out.nth = Number(value);
    else if (key === 'exact') out.exact = value === 'true';
    else out[key] = value;
  }
  return out;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

/** Human description of a target, echoed back so agents can confirm what was hit. */
export function describeTarget(spec: TargetSpec): string {
  switch (spec.kind) {
    case 'ref':
      return `ref ${spec.ref}`;
    case 'role':
      return `role ${spec.role}${spec.name ? ` named "${spec.name}"` : ''}`;
    case 'text':
      return `text "${truncate(spec.text, 48)}"`;
    case 'label':
      return `label "${truncate(spec.text, 48)}"`;
    case 'placeholder':
      return `placeholder "${truncate(spec.text, 48)}"`;
    case 'testid':
      return `test id ${spec.id}`;
    case 'css':
      return `selector ${truncate(spec.selector, 60)}`;
    case 'xpath':
      return `xpath ${truncate(spec.expression, 60)}`;
    case 'coords':
      return `coordinates ${spec.x},${spec.y}`;
    default:
      return 'element';
  }
}

export class TargetResolver {
  constructor(private readonly options: { allowCoordinates?: boolean } = {}) {}

  async resolve(spec: TargetSpec, context: ResolveOptions): Promise<ResolvedTarget> {
    const { page, snapshot, registry } = context;

    if (spec.kind === 'coords') {
      return {
        kind: 'point',
        x: spec.x,
        y: spec.y,
        via: 'coords',
        description: describeTarget(spec),
        recovered: false,
      };
    }

    if (spec.kind === 'ref') {
      const direct = page.locator(`aria-ref=${spec.ref}`);
      if ((await direct.count()) > 0) {
        const element = snapshot?.elements.find((e) => e.ref === spec.ref) ?? registry?.get(spec.ref);
        return {
          kind: 'locator',
          locator: direct,
          via: 'aria-ref',
          description: `${describeTarget(spec)}${element ? ` (${element.role}${element.name ? ` "${truncate(element.name, 40)}"` : ''})` : ''}`,
          element,
          recovered: false,
          box: element?.box,
        };
      }
      const recovered = await this.reacquireRef(spec.ref, context);
      if (recovered) return recovered;
      throw this.staleRefError(spec.ref, context);
    }

    const locator = this.buildLocator(page, spec);
    const count = await locator.count();

    if (count === 0) {
      const fuzzy = await this.fuzzyFromSnapshot(spec, context);
      if (fuzzy) return fuzzy;
      throw this.notFoundError(spec, context);
    }

    const nth = spec.kind === 'role' || spec.kind === 'css' || spec.kind === 'text' || spec.kind === 'label' || spec.kind === 'placeholder' ? spec.nth : undefined;
    if (count > 1) {
      if (nth !== undefined) {
        if (nth >= count) {
          throw new LensError({
            code: LensErrorCode.TARGET_AMBIGUOUS,
            message: `Only ${count} elements matched ${describeTarget(spec)}, so nth=${nth} does not exist.`,
            scope: 'input',
            hints: [`Use a nth between 0 and ${count - 1}.`],
          });
        }
        return { kind: 'locator', locator: locator.nth(nth), via: spec.kind, description: `${describeTarget(spec)} [nth=${nth}]`, recovered: false };
      }
      if (count === 2 && snapshot) {
        // Prefer the visible one; many "duplicate" matches are a hidden mobile/desktop variant.
        const visible = await firstVisible(locator, count);
        if (visible !== null) {
          log.debug('resolved ambiguous target to first visible match', { spec: describeTarget(spec), index: visible });
          return {
            kind: 'locator',
            locator: locator.nth(visible),
            via: `${spec.kind}+visible`,
            description: `${describeTarget(spec)} (1 of ${count} matches, first visible)`,
            recovered: false,
          };
        }
      }
      throw new LensError({
        code: LensErrorCode.TARGET_AMBIGUOUS,
        message: `${count} elements matched ${describeTarget(spec)}.`,
        scope: 'input',
        detail: await describeMatches(locator, count),
        hints: [
          'Disambiguate with nth (e.g. role=button[name="Save"] [nth=1]) or a more specific target.',
          'Take a fresh snapshot and use the ref instead: refs always address exactly one element.',
        ],
        data: { matches: count },
      });
    }

    const element = snapshot ? await matchSnapshotElement(locator, snapshot) : undefined;
    return { kind: 'locator', locator, via: spec.kind, description: describeTarget(spec), recovered: false, element, box: element?.box };
  }

  private buildLocator(page: Page, spec: TargetSpec): Locator {
    switch (spec.kind) {
      case 'role': {
        const options: Parameters<Page['getByRole']>[1] = {};
        if (spec.name !== undefined) options.name = new RegExp(`^${escapeRegExp(spec.name)}$`, spec.exact ? '' : 'i');
        if (!spec.exact && spec.name === undefined) options.name = undefined;
        return page.getByRole(spec.role as never, options);
      }
      case 'text':
        return page.getByText(spec.text, spec.exact ? { exact: true } : {});
      case 'label':
        return page.getByLabel(spec.text, spec.exact ? { exact: true } : {});
      case 'placeholder':
        return page.getByPlaceholder(spec.text, spec.exact ? { exact: true } : {});
      case 'testid':
        return page.getByTestId(spec.id);
      case 'css': {
        const base = page.locator(spec.selector);
        return base;
      }
      case 'xpath':
        return page.locator(`xpath=${spec.expression}`);
      default:
        return page.locator('body');
    }
  }

  /**
   * A ref that no longer resolves is a re-render, not an agent mistake. Re-snapshot
   * and find the same role+name — that keeps multi-step flows working across
   * client-side navigation.
   */
  private async reacquireRef(ref: string, context: ResolveOptions): Promise<ResolvedTarget | null> {
    const known = context.registry?.get(ref) ?? context.snapshot?.elements.find((e) => e.ref === ref);
    if (!known) return null;
    log.debug('ref is stale; re-acquiring by role+name', { ref, role: known.role, name: known.name });

    const fresh = await context.snapshotProvider?.();
    if (!fresh) return null;
    const candidate =
      fresh.elements.find((e) => e.role === known.role && sameName(e.name, known.name)) ??
      fresh.elements.find((e) => e.role === known.role && containsName(e.name, known.name));
    if (!candidate) return null;
    const locator = context.page.locator(`aria-ref=${candidate.ref}`);
    if ((await locator.count()) === 0) return null;
    return {
      kind: 'locator',
      locator,
      via: 'aria-ref+reacquired',
      description: `${known.role}${known.name ? ` "${truncate(known.name, 40)}"` : ''} (ref ${ref} re-acquired as ${candidate.ref} after the page changed)`,
      element: candidate,
      recovered: true,
      box: candidate.box,
    };
  }

  private async fuzzyFromSnapshot(spec: TargetSpec, context: ResolveOptions): Promise<ResolvedTarget | null> {
    const wanted = wantedName(spec);
    if (!wanted) return null;
    const fresh = await context.snapshotProvider?.();
    const pool = fresh?.elements.length ? fresh.elements : (context.snapshot?.elements ?? []);
    if (!pool.length) return null;
    const scored = pool
      .map((element) => ({ element, score: similarity(wanted, `${element.name ?? ''} ${element.value ?? ''}`) }))
      .filter((entry) => entry.score > 0.55)
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return null;
    const locator = context.page.locator(`aria-ref=${best.element.ref}`);
    if ((await locator.count()) === 0) return null;
    return {
      kind: 'locator',
      locator,
      via: `${spec.kind}+fuzzy`,
      description: `${best.element.role} "${truncate(best.element.name ?? '', 40)}" (closest match to ${describeTarget(spec)})`,
      element: best.element,
      recovered: true,
      box: best.element.box,
    };
  }

  private staleRefError(ref: string, context: ResolveOptions): LensError {
    const elements = context.snapshot?.elements ?? [];
    const listing = elements.length
      ? elements.slice(0, 8).map((e) => `  ${e.ref}  ${e.role}${e.name ? ` "${truncate(e.name, 40)}"` : ''}`).join('\n')
      : '  (no interactive elements were recorded for this page)';
    return new LensError({
      code: LensErrorCode.TARGET_STALE,
      message: `Element ref "${ref}" is no longer in the page, and its role/name could not be re-found.`,
      scope: 'application',
      detail: `Current interactive elements:\n${listing}`,
      hints: [
        'Take a new snapshot and use a ref from it: `lens snapshot`.',
        'If the app just navigated, the previous element is gone by design — target the element on the new page.',
        'Refs are regenerated on every snapshot; do not reuse them across page loads.',
      ],
      retryable: true,
      data: { ref, available: elements.map((e) => e.ref) },
    });
  }

  private notFoundError(spec: TargetSpec, context: ResolveOptions): LensError {
    const wanted = wantedName(spec);
    const pool = context.snapshot?.elements ?? [];
    const similar = wanted
      ? pool
          .map((element) => ({ element, score: similarity(wanted, `${element.name ?? ''}`) }))
          .filter((entry) => entry.score > 0.35)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
      : [];
    return new LensError({
      code: LensErrorCode.TARGET_NOT_FOUND,
      message: `No element matched ${describeTarget(spec)}.`,
      scope: 'input',
      detail: similar.length
        ? `Closest elements on the page:\n${similar.map((s) => `  ${s.element.ref}  ${s.element.role} "${truncate(s.element.name ?? '', 40)}"`).join('\n')}`
        : `The page has ${pool.length} interactive element(s).`,
      hints: [
        'Run `lens snapshot` to see the current accessibility tree with refs.',
        'If the element is behind interaction (a menu, tab or dialog), open it first.',
        'For lazy-rendered lists, scroll the item into view before targeting it.',
      ],
      data: { target: describeTarget(spec), candidates: similar.map((s) => ({ ref: s.element.ref, role: s.element.role, name: s.element.name })) },
    });
  }
}

function wantedName(spec: TargetSpec): string | null {
  switch (spec.kind) {
    case 'role':
      return spec.name ?? null;
    case 'text':
    case 'label':
    case 'placeholder':
      return spec.text;
    case 'testid':
      return spec.id;
    default:
      return null;
  }
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  return normalize(a) === normalize(b);
}

function containsName(a: string | undefined, b: string | undefined): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

function normalize(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Cheap token-overlap similarity; adequate for suggesting "did you mean". */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  const union = new Set([...ta, ...tb]).size;
  const ratio = union ? shared / union : 0;
  const lengthRatio = 1 - Math.abs(na.length - nb.length) / Math.max(na.length, nb.length);
  return Math.max(ratio, ratio * 0.6 + lengthRatio * 0.4);
}

async function firstVisible(locator: Locator, count: number): Promise<number | null> {
  let visibleCount = 0;
  let firstIndex: number | null = null;
  for (let index = 0; index < Math.min(count, 10); index += 1) {
    const candidate = locator.nth(index);
    const isVisible = await candidate.isVisible().catch(() => false);
    if (!isVisible) continue;
    visibleCount += 1;
    if (firstIndex === null) firstIndex = index;
  }
  return visibleCount === 1 ? firstIndex : null;
}

async function describeMatches(locator: Locator, count: number): Promise<string> {
  const lines: string[] = [];
  for (let index = 0; index < Math.min(count, 6); index += 1) {
    const candidate = locator.nth(index);
    const text = await candidate.evaluate((el) => `${el.tagName.toLowerCase()} ${[...el.classList].slice(0, 2).join('.')}`.trim()).catch(() => 'unknown');
    const visible = await candidate.isVisible().catch(() => false);
    lines.push(`  nth=${index}  ${text}${visible ? '' : '  (hidden)'}`);
  }
  if (count > 6) lines.push(`  … ${count - 6} more`);
  return lines.join('\n');
}

async function matchSnapshotElement(locator: Locator, snapshot: PageSnapshot): Promise<InteractiveElement | undefined> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return undefined;
  return snapshot.elements.find(
    (element) =>
      Math.abs(element.box.x - box.x) < 2 &&
      Math.abs(element.box.y - box.y) < 2 &&
      Math.abs(element.box.width - box.width) < 2 &&
      Math.abs(element.box.height - box.height) < 2,
  );
}

/** Escape a value for use inside a Playwright role selector. */
export function escapeRoleName(name: string): string {
  return name.replace(/["\\]/g, '\\$&');
}
