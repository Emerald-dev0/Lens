/**
 * Interaction primitives — Lens's "hands".
 *
 * Every verb resolves through the target hierarchy first, then runs with an
 * explicit actionability check, so a failure says "this button is covered by a
 * dialog" rather than "timeout 30000ms exceeded".
 */
import type { Locator, Page } from 'playwright-core';

import process from 'node:process';

import type { LensConfig } from '../config/schema.js';
import { LensError, LensErrorCode } from '../errors.js';
import { log } from '../util/log.js';
import { isSafeUploadPath } from './files.js';
import { TargetResolver, describeTarget, parseTarget, type ResolvedTarget } from './resolve.js';
import type { InteractiveElement, PageSnapshot, SnapshotService } from '../observe/snapshot.js';
import { truncate } from '../util/text.js';

export type ActionKind =
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'focus'
  | 'type'
  | 'fill'
  | 'append'
  | 'clear'
  | 'press'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'set-checked'
  | 'drag'
  | 'scroll'
  | 'upload'
  | 'blur'
  | 'tap';

export interface ActionParams {
  text?: string;
  key?: string;
  values?: string[];
  label?: boolean;
  index?: number;
  checked?: boolean;
  direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom';
  amount?: number;
  intoView?: boolean;
  files?: string[];
  target?: string;
  button?: 'left' | 'right' | 'middle';
  count?: number;
  delayMs?: number;
  force?: boolean;
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  submit?: boolean;
  timeoutMs?: number;
  position?: { x: number; y: number };
  /** Disambiguate when a target matches more than one element. */
  nth?: number;
  /** Require an exact accessible-name/text match. */
  exact?: boolean;
}

export interface ActionResult {
  op: ActionKind;
  target: string;
  via: string;
  recovered: boolean;
  durationMs: number;
  url: string;
  title: string;
  /** Did this action change where the agent is? */
  navigated: boolean;
  note: string;
  element?: { ref?: string; role?: string; name?: string; box?: InteractiveElement['box'] };
  /** Extra observations the caller may want to surface. */
  data?: Record<string, unknown>;
}

export interface ActionContext {
  page: Page;
  snapshot: PageSnapshot | null;
  registry: Map<string, InteractiveElement>;
  snapshotProvider: () => Promise<PageSnapshot | null>;
}

export class ActionService {
  private readonly resolver: TargetResolver;

  constructor(
    private readonly config: LensConfig,
    private readonly snapshots: SnapshotService,
    /** Project root used to bound file uploads. */
    private readonly rootDir: string = process.cwd(),
    /** Directories beyond the project root that uploads may read. */
    private readonly allowedUploadDirs: string[] = [],
  ) {
    this.resolver = new TargetResolver();
  }

  resolveTarget(raw: string, context: ActionContext, extra: { nth?: number; exact?: boolean } = {}): Promise<ResolvedTarget> {
    const spec = parseTarget(raw);
    return this.resolver.resolve(spec, {
      page: context.page,
      snapshot: context.snapshot,
      registry: context.registry,
      snapshotProvider: context.snapshotProvider,
      ...extra,
    });
  }

  async perform(kind: ActionKind, raw: string | null, params: ActionParams, context: ActionContext): Promise<ActionResult> {
    const started = Date.now();
    const before = { url: context.page.url(), title: await context.page.title().catch(() => '') };
    const spec = raw === null || raw === undefined ? null : parseTarget(raw);

    if (!spec && !['press', 'scroll', 'navigate'].includes(kind)) {
      throw LensError.usage(`\`lens ${kind}\` needs an element target.`, [
        `Example: lens ${kind} e12${kind === 'type' || kind === 'fill' ? ' "text to enter"' : ''}`,
        'Run `lens snapshot` for the ref list, or address the element with role=…/css=…/text="…".',
      ]);
    }

    const resolved = spec
      ? await this.resolver.resolve(spec, {
          page: context.page,
          snapshot: context.snapshot,
          registry: context.registry,
          snapshotProvider: context.snapshotProvider,
          ...(params.nth !== undefined ? { nth: params.nth } : {}),
          ...(params.exact !== undefined ? { exact: params.exact } : {}),
        })
      : null;

    const description = resolved ? resolved.description : describeTarget(spec ?? { kind: 'css', selector: 'body' });
    const locator = resolved && resolved.kind === 'locator' ? resolved.locator : null;
    const point = resolved && resolved.kind === 'point' ? resolved : null;
    const timeout = params.timeoutMs ?? this.config.defaults.actionTimeoutMs;

    const guard = async <T>(run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run();
      } catch (err) {
        throw await this.classify(err, kind, description, locator, params);
      }
    };

    switch (kind) {
      case 'click':
      case 'tap': {
        if (point) {
          await guard(() => context.page.mouse.click(point.x, point.y, { button: params.button ?? 'left', clickCount: params.count ?? 1, delay: params.delayMs }));
        } else if (locator) {
          await this.assertActionable(locator, params, description);
          await guard(() =>
            locator.click({
              button: params.button ?? 'left',
              clickCount: params.count ?? 1,
              delay: params.delayMs,
              force: params.force,
              modifiers: params.modifiers,
              position: params.position,
              timeout,
              trial: false,
            }),
          );
        }
        break;
      }
      case 'dblclick': {
        if (point) await guard(() => context.page.mouse.dblclick(point.x, point.y));
        else if (locator) {
          await this.assertActionable(locator, params, description);
          await guard(() => locator.dblclick({ force: params.force, timeout }));
        }
        break;
      }
      case 'hover': {
        if (point) await guard(() => context.page.mouse.move(point.x, point.y));
        else if (locator) await guard(() => locator.hover({ force: params.force, timeout }));
        break;
      }
      case 'focus': {
        if (locator) await guard(() => locator.focus({ timeout }));
        break;
      }
      case 'blur': {
        if (locator) await guard(() => locator.blur({ timeout }));
        break;
      }
      case 'type': {
        const text = requireText(kind, params.text);
        if (locator) {
          await this.assertActionable(locator, params, description);
          await guard(() => locator.pressSequentially(text, { delay: params.delayMs ?? 12, timeout }));
          if (params.submit) await guard(() => locator.press('Enter'));
        }
        break;
      }
      case 'fill': {
        const text = params.text ?? '';
        if (locator) {
          await this.assertActionable(locator, params, description);
          await guard(() => locator.fill(text, { timeout }));
          if (params.submit) await guard(() => locator.press('Enter'));
        }
        break;
      }
      case 'append': {
        const text = requireText(kind, params.text);
        if (locator) {
          await guard(async () => {
            const current = await locator.inputValue().catch(() => '');
            await locator.fill(`${current}${text}`, { timeout });
          });
        }
        break;
      }
      case 'clear': {
        if (locator) await guard(() => locator.fill('', { timeout }));
        break;
      }
      case 'press': {
        const key = requireText(kind, params.key ?? params.text ?? '', 'a key combination');
        if (locator) await guard(() => locator.press(key, { timeout }));
        else await guard(() => context.page.keyboard.press(key));
        break;
      }
      case 'select': {
        if (!locator) break;
        const values = params.values ?? (params.text ? [params.text] : []);
        if (!values.length) {
          throw LensError.usage('`lens select` needs at least one option value.', [
            'Example: lens select e8 acme --value pro',
            'Inspect available options with `lens snapshot --root select`.',
          ]);
        }
        await guard(() =>
          locator.selectOption(
            values.map((value) => (params.label ? { label: value } : params.index !== undefined ? { index: params.index } : { value })),
            { timeout },
          ),
        );
        break;
      }
      case 'check':
      case 'uncheck':
      case 'set-checked': {
        if (!locator) break;
        const next = kind === 'check' ? true : kind === 'uncheck' ? false : (params.checked ?? true);
        await this.assertActionable(locator, params, description);
        await guard(() => (next ? locator.check({ timeout, force: params.force }) : locator.uncheck({ timeout, force: params.force })));
        break;
      }
      case 'drag': {
        if (!locator) break;
        const targetRaw = params.target;
        if (!targetRaw) throw LensError.usage('`lens drag` needs --to <target>.', ['Example: lens drag e4 --to e9']);
        const destination = await this.resolver.resolve(parseTarget(targetRaw), {
          page: context.page,
          snapshot: context.snapshot,
          registry: context.registry,
          snapshotProvider: context.snapshotProvider,
        });
        if (destination.kind === 'locator') await guard(() => locator.dragTo(destination.locator, { timeout }));
        else if (destination.kind === 'point') {
          const from = resolved && resolved.kind === 'point' ? resolved : await centerOf(locator!);
          await guard(async () => {
            await context.page.mouse.move(from.x, from.y);
            await context.page.mouse.down();
            await context.page.mouse.move(destination.x, destination.y, { steps: 12 });
            await context.page.mouse.up();
          });
        }
        break;
      }
      case 'scroll': {
        await guard(() => this.scroll(context.page, params, locator));
        break;
      }
      case 'upload': {
        if (!locator) break;
        const files = params.files ?? [];
        if (!files.length) {
          throw LensError.usage('`lens upload` needs at least one file path.', [
            'Example: lens upload e12 ./fixtures/report.pdf',
            'If the trigger is a button rather than an input, Lens opens the file chooser for you — pass the button ref.',
          ]);
        }
        for (const file of files) {
          const check = isSafeUploadPath(file, this.rootDir, { allowedDirs: this.allowedUploadDirs });
          if (!check.ok) {
            throw new LensError({
              code: LensErrorCode.SECURITY_PERMISSION_REQUIRED,
              message: `Lens will not upload ${file}: ${check.reason}`,
              scope: 'input',
              hints: ['Uploads are restricted to files inside the project directory, or paths explicitly allowed with --allow-path.'],
              data: { file },
            });
          }
        }
        const tag = await locator.evaluate((el) => (el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase())).catch(() => '');
        if (tag === 'file' || tag === 'input') await guard(() => locator.setInputFiles(files, { timeout }));
        else {
          // Button-triggered picker: wait for the chooser the click will open.
          const [chooser] = await Promise.all([
            context.page.waitForEvent('filechooser', { timeout: Math.min(timeout, 5000) }),
            locator.click({ timeout }),
          ]).catch(() => [null] as const);
          if (chooser) await guard(() => chooser.setFiles(files));
          else throw new LensError({
            code: LensErrorCode.TARGET_NOT_ACTIONABLE,
            message: `Clicking ${description} opened no file chooser, and the element is not a file input.`,
            scope: 'application',
            hints: ['Target the real <input type="file"> instead: `lens snapshot --root input[type=file]` (it may be visually hidden).'],
          });
        }
        break;
      }
      default:
        throw new LensError({
          code: LensErrorCode.ACTION_UNSUPPORTED,
          message: `Unsupported action "${kind}".`,
          scope: 'input',
          hints: ['Supported: click, dblclick, hover, focus, blur, type, fill, append, clear, press, select, check, uncheck, drag, scroll, upload.'],
        });
    }

    await this.afterAction(context.page);

    const hitElement = resolved && resolved.kind === 'locator' ? resolved.element : undefined;
    const url = context.page.url();
    const title = await context.page.title().catch(() => '');
    const navigated = url !== before.url || title !== before.title;
    const durationMs = Date.now() - started;

    return {
      op: kind,
      target: description,
      via: resolved?.via ?? 'keyboard',
      recovered: resolved?.recovered ?? false,
      durationMs,
      url,
      title,
      navigated,
      note: buildNote(kind, description, before, { url, title }, navigated, hitElement),
      element: hitElement,
      data: resolved && resolved.kind === 'locator' && resolved.box ? { box: resolved.box } : undefined,
    };
  }

  /** Give client-side rendering a chance to settle before evidence is captured. */
  private async afterAction(page: Page): Promise<void> {
    const settle = this.config.defaults.settleMs;
    if (settle > 0) await page.waitForTimeout(settle).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
  }

  private async scroll(page: Page, params: ActionParams, locator: Locator | null): Promise<void> {
    const amount = params.amount ?? Math.round((this.config.viewport.height || 800) * 0.8);
    if (params.intoView && locator) {
      await locator.scrollIntoViewIfNeeded({ timeout: params.timeoutMs ?? this.config.defaults.actionTimeoutMs });
      return;
    }
    if (locator) {
      await locator.evaluate((element, payload) => {
        if (payload.to === 'top') element.scrollTop = 0;
        else if (payload.to === 'bottom') element.scrollTop = element.scrollHeight;
        else {
          const delta = payload.amount;
          if (payload.direction === 'up') element.scrollTop -= delta;
          else if (payload.direction === 'left') element.scrollLeft -= delta;
          else if (payload.direction === 'right') element.scrollLeft += delta;
          else element.scrollTop += delta;
        }
      }, { direction: params.direction ?? 'down', amount, to: params.direction === 'top' ? 'top' : params.direction === 'bottom' ? 'bottom' : undefined });
      return;
    }
    await page.evaluate((payload) => {
      const delta = payload.amount;
      const x = window.scrollX;
      const y = window.scrollY;
      switch (payload.direction) {
        case 'up':
          window.scrollBy({ left: 0, top: -delta, behavior: 'instant' as ScrollBehavior });
          break;
        case 'left':
          window.scrollBy({ left: -delta, top: 0, behavior: 'instant' as ScrollBehavior });
          break;
        case 'right':
          window.scrollBy({ left: delta, top: 0, behavior: 'instant' as ScrollBehavior });
          break;
        case 'top':
          window.scrollTo({ left: x, top: 0, behavior: 'instant' as ScrollBehavior });
          break;
        case 'bottom':
          window.scrollTo({ left: x, top: document.documentElement.scrollHeight, behavior: 'instant' as ScrollBehavior });
          break;
        default:
          window.scrollBy({ left: 0, top: delta, behavior: 'instant' as ScrollBehavior });
      }
    }, { direction: params.direction ?? 'down', amount });
  }

  /**
   * Actionability with a diagnosis. A click that times out is almost always one of
   * five things, and telling an agent which one is the whole value of the layer.
   */
  private async assertActionable(locator: Locator, params: ActionParams, description: string): Promise<void> {
    if (params.force) return;
    const info = await describeElement(locator);
    if (info.disabled) {
      throw new LensError({
        code: LensErrorCode.TARGET_NOT_ACTIONABLE,
        message: `${description} is disabled.`,
        scope: 'application',
        detail: info.summary,
        hints: [
          'Fill the required field(s) it depends on first, or check whether the app gates this action behind a state you have not reached.',
          'If you need to bypass the check to inspect layout, pass --force.',
        ],
        data: { ...info },
      });
    }
    if (!info.visible) {
      throw new LensError({
        code: LensErrorCode.TARGET_NOT_VISIBLE,
        message: `${description} is not visible.`,
        scope: 'application',
        detail: info.summary,
        hints: [
          'It may be inside a collapsed panel, an inactive tab, or a closed menu — open that first.',
          'It may be off-screen; try `lens scroll e12 --into-view`.',
          'CSS may hide it (display:none/visibility:hidden/opacity:0). `lens inspect --box e12` shows computed styles.',
        ],
        data: { ...info },
      });
    }
  }

  private async classify(err: unknown, kind: ActionKind, description: string, locator: Locator | null, params: ActionParams): Promise<LensError> {
    if (err instanceof LensError) return err;
    const message = (err as Error).message ?? String(err);
    const timeout = /Timeout \d+ms exceeded|waiting for/i.test(message);
    if (timeout && locator && !params.force) {
      const info = await describeElement(locator);
      const intercepted = /intercepts pointer events|element is not enabled|outside of the viewport|covered/i.test(message);
      return new LensError({
        code: intercepted ? LensErrorCode.TARGET_NOT_ACTIONABLE : LensErrorCode.ACTION_FAILED,
        message: intercepted
          ? `Another element covers ${description}, so the ${kind} was blocked.`
          : `The ${kind} on ${description} timed out after ${this.config.defaults.actionTimeoutMs}ms.`,
        scope: 'application',
        detail: [info.summary, message.split('\n').slice(0, 3).join(' | ')].join('\n'),
        hints: intercepted
          ? ['Close the dialog, banner or sticky footer that is on top of it, or scroll the element into view.', 'Use --force to click through the obstruction when you only need the state change.']
          : ['Retry after `lens wait --idle`, or increase defaults.actionTimeoutMs.', 'If the app waits on a network call that never resolves, check `lens network --problems`.'],
        cause: err,
        retryable: true,
        data: { kind, target: description, actionability: { ...info } },
      });
    }
    return new LensError({
      code: LensErrorCode.ACTION_FAILED,
      message: `The ${kind} on ${description} failed.`,
      scope: 'application',
      detail: message.split('\n').slice(0, 4).join('\n'),
      hints: ['Re-snapshot and retry against a fresh ref.', 'Check `lens console` for an error thrown by the handler.'],
      cause: err,
    });
  }
}

interface ElementDescription {
  visible: boolean;
  disabled: boolean;
  summary: string;
  tag?: string;
  role?: string;
  text?: string;
}

async function describeElement(locator: Locator): Promise<ElementDescription> {
  const visible = await locator.isVisible().catch(() => false);
  const info = await locator
    .first()
    .evaluate((element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const disabled =
        (element as HTMLButtonElement).disabled === true ||
        element.hasAttribute('disabled') ||
        element.getAttribute('aria-disabled') === 'true' ||
        style.pointerEvents === 'none';
      const atPoint = rect.width > 0 && rect.height > 0
        ? (() => {
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return hit && hit !== element && !element.contains(hit) ? (hit.tagName ?? '').toLowerCase() : null;
          })()
        : null;
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') ?? undefined,
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        disabled,
        hidden: style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0,
        zeroSized: rect.width < 1 || rect.height < 1,
        offscreen: rect.bottom < 0 || rect.top > window.innerHeight,
        clipped: rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1),
        coveredBy: atPoint,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    })
    .catch(() => null);

  const parts: string[] = [];
  if (info) {
    parts.push(`<${info.tag}>${info.role ? ` role=${info.role}` : ''}${info.text ? ` text="${truncate(info.text, 50)}"` : ''}`);
    parts.push(`box=${info.rect.x},${info.rect.y} ${info.rect.width}x${info.rect.height}`);
    if (info.hidden) parts.push('css-hidden (display/visibility/opacity)');
    if (info.zeroSized) parts.push('zero-sized');
    if (info.offscreen) parts.push('outside the viewport');
    if (info.clipped) parts.push('extends past the viewport edge');
    if (info.coveredBy) parts.push(`topmost element at its centre is <${info.coveredBy}>`);
  }
  return {
    visible,
    disabled: info?.disabled ?? false,
    summary: parts.length ? parts.join('\n') : 'Element could not be measured (it may have been removed from the DOM).',
    tag: info?.tag,
    role: info?.role,
    text: info?.text,
  };
}

async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) throw new LensError({ code: LensErrorCode.TARGET_NOT_VISIBLE, message: 'Cannot compute a coordinate for an element with no box.', scope: 'application' });
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function requireText(kind: ActionKind, value: string | undefined, what = 'text'): string {
  if (value === undefined || value === '') {
    throw LensError.usage(`\`lens ${kind}\` needs ${what}.`, [`Example: lens ${kind} e12 --text "your ${what}"`]);
  }
  return value;
}

function buildNote(
  kind: ActionKind,
  description: string,
  before: { url: string; title: string },
  after: { url: string; title: string },
  navigated: boolean,
  element?: InteractiveElement,
): string {
  const label = element?.name ? `"${truncate(element.name, 32)}"` : description;
  if (navigated) {
    const to = shortUrl(after.url);
    return `${kind} ${label} → ${to}`;
  }
  if (kind === 'fill' || kind === 'type') return `${kind} ${label}`;
  void before;
  return `${kind} ${label}`;
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search}`.slice(0, 90);
  } catch {
    return url.slice(0, 90);
  }
}
