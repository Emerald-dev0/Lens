/**
 * Visual review.
 *
 * Turns raw measurements into findings an agent can act on. Each check is its own
 * method so it can be enabled, skipped or threshold-tuned in isolation, and every
 * finding carries the element, the geometry and a concrete fix.
 *
 * These are heuristics, deliberately: Lens reports what is measurably wrong with
 * the rendered page and leaves taste to the agent. It never claims to be an audit.
 */
import type { Page } from 'playwright-core';

import type { ResolvedConfig } from '../config/load.js';
import type { Finding, Verdict } from './types.js';
import { computeVerdict } from '../artifacts/report.js';
import type { ConsoleCollector } from '../observe/console.js';
import type { NetworkCollector } from '../observe/network.js';
import type { PageProbeResult } from './probe.js';
import { pageProbe, type ProbeInput } from './probe.js';
import { LensError, LensErrorCode } from '../errors.js';
import { pluralize, truncate } from '../util/text.js';

export const VISUAL_CHECKS = [
  'layout-overflow',
  'clipped-text',
  'contrast',
  'broken-images',
  'empty-state',
  'tap-targets',
  'overlap',
  'unstyled',
  'focus-visible',
  'touch-scroll',
  'console',
  'network',
  'form-labels',
  'alt-text',
  'text-density',
] as const;

export type VisualCheck = (typeof VISUAL_CHECKS)[number];

export interface VisualReviewOptions {
  /** Overrides the configured check set. */
  checks?: VisualCheck[];
  skip?: VisualCheck[];
  includePassing?: boolean;
  /** Label used in findings for multi-page reviews (e.g. the route). */
  location?: string;
  viewportName?: string;
  /** Attribute console/network noise observed after this sequence number. */
  since?: { consoleSeq?: number; networkSeq?: number };
}

export interface CheckSummary {
  name: VisualCheck;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  count: number;
  detail: string;
}

export interface VisualReviewResult {
  verdict: Verdict;
  findings: Finding[];
  checks: CheckSummary[];
  probe: PageProbeResult;
  measuredAt: string;
  summary: string;
}

interface Context {
  location?: string;
  viewport?: string;
  includePassing: boolean;
}

export class VisualReviewer {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly collectors: { console?: ConsoleCollector; network?: NetworkCollector } = {},
  ) {}

  async probe(page: Page): Promise<PageProbeResult> {
    const thresholds = this.config.review.thresholds;
    const input: ProbeInput = {
      limit: Math.min(this.config.review.maxIssuesPerCheck, 60),
      overflowTolerancePx: thresholds.overflowTolerancePx,
      minContrast: thresholds.minContrast,
      minContrastLargeText: thresholds.minContrastLargeText,
      minTapTargetPx: thresholds.minTapTargetPx,
      emptyAreaRatio: thresholds.emptyAreaRatio,
      overlapSeverityAreaPx: thresholds.overlapSeverityAreaPx,
      minLineHeightRatio: thresholds.minLineHeightRatio,
      ignoreSelectors: this.config.review.ignoreSelectors,
    };
    try {
      return await page.evaluate(pageProbe as never, input as never);
    } catch (err) {
      throw new LensError({
        code: LensErrorCode.REVIEW_FAILED,
        message: 'The layout probe could not run on this page.',
        scope: 'browser',
        detail: (err as Error).message.split('\n')[0],
        hints: [
          'The document may have been replaced while measuring — re-open and retry.',
          'Pages that block script execution cannot be measured; `lens screenshot` still works.',
        ],
        cause: err,
        retryable: true,
      });
    }
  }

  async review(page: Page, options: VisualReviewOptions = {}): Promise<VisualReviewResult> {
    const enabled = (options.checks ?? (this.config.review.checks as VisualCheck[])).filter((check) => !(options.skip ?? []).includes(check));
    const probe = await this.probe(page);
    const findings: Finding[] = [];
    const checks: CheckSummary[] = [];
    const context: Context = {
      location: options.location,
      viewport: options.viewportName,
      includePassing: options.includePassing ?? false,
    };

    const run = async (name: VisualCheck, produce: () => Finding[] | Promise<Finding[]>): Promise<void> => {
      if (!enabled.includes(name)) {
        checks.push({ name, status: 'skipped', count: 0, detail: 'disabled in configuration' });
        return;
      }
      const produced = await produce();
      findings.push(...produced);
      const errors = produced.filter((f) => f.severity === 'error').length;
      const warnings = produced.filter((f) => f.severity === 'warning').length;
      checks.push({
        name,
        status: errors > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
        count: produced.length,
        detail: describeCheck(name, produced, probe),
      });
    };

    await run('layout-overflow', () => this.layoutOverflow(probe, context));
    await run('clipped-text', () => this.clippedText(probe, context));
    await run('contrast', () => this.contrast(probe, context));
    await run('broken-images', () => this.brokenImages(probe, context));
    await run('empty-state', () => this.emptyState(probe, context));
    await run('tap-targets', () => this.tapTargets(probe, context));
    await run('overlap', () => this.overlap(probe, context));
    await run('unstyled', () => this.unstyled(probe, context));
    await run('focus-visible', () => this.focusVisible(probe, context));
    await run('touch-scroll', () => this.touchScroll(probe, context));
    await run('form-labels', () => this.formLabels(probe, context));
    await run('alt-text', () => this.altText(probe, context));
    await run('text-density', () => this.textDensity(probe, context));
    await run('console', () => this.consoleFindings(context, options.since?.consoleSeq ?? 0));
    await run('network', () => this.networkFindings(context, options.since?.networkSeq ?? 0));

    const verdict = computeVerdict(findings);
    return {
      verdict,
      findings,
      checks,
      probe,
      measuredAt: new Date().toISOString(),
      summary: this.summarize(probe, findings, verdict, context),
    };
  }

  // ------------------------------------------------------------- individual checks

  private layoutOverflow(probe: PageProbeResult, context: Context): Finding[] {
    const out: Finding[] = [];
    const tolerance = this.config.review.thresholds.overflowTolerancePx;
    if (probe.horizontalOverflow) {
      out.push({
        check: 'layout-overflow',
        severity: 'error',
        message: `The document is wider than the viewport (${probe.document.scrollWidth}px content in a ${probe.viewport.width}px viewport) — the page scrolls sideways.`,
        location: context.location,
        viewport: context.viewport,
        meta: { scrollWidth: probe.document.scrollWidth, viewportWidth: probe.viewport.width, tolerance },
        suggestion: 'Find the element exceeding the viewport below and constrain it (max-width:100%, min-width:0 on flex children, or wrap/scroll the row).',
      });
    }
    for (const item of probe.overflow.items.slice(0, 10)) {
      out.push({
        check: 'layout-overflow',
        severity: 'warning',
        message: `<${item.tag}> extends ${item.overflowPx}px past the viewport edge.`,
        detail: item.text ? `Text: "${truncate(item.text, 70)}"` : undefined,
        location: context.location,
        viewport: context.viewport,
        element: { selector: item.selector, bounds: item.box, style: { position: item.position } },
        suggestion:
          item.position === 'absolute'
            ? 'Absolutely positioned element ignores its container width — add a right/left constraint or max-width.'
            : 'Check for a fixed width, a long unbreakable string, or a grid/flex track that cannot shrink.',
      });
    }
    if (!out.length && context.includePassing) {
      out.push(pass('layout-overflow', 'No horizontal overflow at this viewport.', context));
    }
    return out;
  }

  private clippedText(probe: PageProbeResult, context: Context): Finding[] {
    const out: Finding[] = probe.clipped.items.slice(0, 12).map((item) => ({
      check: 'clipped-text' as const,
      severity: 'error' as const,
      message: `Text is cut off inside <${item.tag}> (${item.clippedBy}px hidden, overflow ${item.overflow}).`,
      detail: `"${truncate(item.text, 90)}"`,
      location: context.location,
      viewport: context.viewport,
      element: {
        selector: item.selector,
        bounds: item.box,
        style: { fontSize: item.fontSize, whiteSpace: item.whiteSpace, textOverflow: item.textOverflow },
      },
      suggestion:
        item.textOverflow === 'ellipsis'
          ? 'Ellipsis is intentional but the box is too small for the content — widen the container or shorten the label.'
          : item.whiteSpace === 'nowrap'
            ? 'Remove white-space:nowrap or allow wrapping at this width.'
            : 'Give the element more height (or use min-height), or let it grow with the content.',
      meta: { clippedBy: item.clippedBy },
    }));
    if (!out.length && context.includePassing) out.push(pass('clipped-text', 'No clipped text containers found.', context));
    return out;
  }

  private contrast(probe: PageProbeResult, context: Context): Finding[] {
    const items = probe.contrast.items.slice(0, 12);
    const out: Finding[] = items.map((item) => ({
      check: 'contrast',
      severity: item.ratio < 2.5 ? ('error' as const) : ('warning' as const),
      message: `Contrast ${item.ratio}:1 is below ${item.required}:1 for "${truncate(item.text, 48)}".`,
      detail: `${item.color} on ${item.background}${item.fontSize ? ` at ${item.fontSize}px${item.bold ? ' bold' : ''}` : ''}`,
      location: context.location,
      viewport: context.viewport,
      element: { selector: item.selector, bounds: item.box, style: { fontSize: item.fontSize, ratio: item.ratio, required: item.required } },
      suggestion: 'Darken the text or lighten the surface. Muted text on a tinted card is the usual culprit.',
      meta: { ratio: item.ratio, required: item.required },
    }));
    if (probe.contrast.skipped > 0 && out.length) {
      out.push({
        check: 'contrast',
        severity: 'info',
        message: `${probe.contrast.skipped} of ${probe.contrast.checked} text nodes were skipped (gradient/image backgrounds) — measure those by eye.`,
        location: context.location,
        viewport: context.viewport,
      });
    }
    if (!out.length && context.includePassing) {
      out.push(pass('contrast', `${probe.contrast.checked} text nodes met ${this.config.review.thresholds.minContrast}:1.`, context));
    }
    return out;
  }

  private brokenImages(probe: PageProbeResult, context: Context): Finding[] {
    const out: Finding[] = [];
    if (probe.images.broken > 0) {
      for (const item of probe.images.items.slice(0, 8)) {
        if (item.complete && item.naturalWidth === 0 && item.src) {
          out.push({
            check: 'broken-images',
            severity: 'error',
            message: `Image failed to load: ${truncate(item.src, 80)}`,
            location: context.location,
            viewport: context.viewport,
            element: { selector: item.src, bounds: item.box, style: { naturalWidth: item.naturalWidth } },
            suggestion: 'Check the asset path (case-sensitive on Linux hosts) or the public/ directory, and confirm the dev server serves it.',
          });
        }
      }
      if (out.length === 0) {
        out.push({
          check: 'broken-images',
          severity: 'error',
          message: `${pluralize(probe.images.broken, 'image')} reported a zero natural size.`,
          location: context.location,
          viewport: context.viewport,
        });
      }
    }
    if (!out.length && context.includePassing) out.push(pass('broken-images', `All ${probe.images.total} image(s) decoded.`, context));
    return out;
  }

  private emptyState(probe: PageProbeResult, context: Context): Finding[] {
    const ratio = probe.empty.ratio;
    const threshold = this.config.review.thresholds.emptyAreaRatio;
    const out: Finding[] = [];
    if (probe.visibleTextLength < 40 && probe.interactiveCount === 0 && probe.images.total === 0) {
      out.push({
        check: 'empty-state',
        severity: 'error',
        message: 'The page renders essentially nothing — no text, no controls, no images.',
        detail: probe.appRootEmpty
          ? 'The app root exists but is empty: the client bundle probably threw during mount.'
          : `readiness=${probe.readyState}, stylesheets=${probe.stylesheets.links + probe.stylesheets.inline}`,
        location: context.location,
        viewport: context.viewport,
        suggestion: 'Read `lens console` for the mount error; a blank page is almost always an exception, not a layout bug.',
      });
    } else if (ratio < 1 - threshold && probe.empty.largestGapY > 240) {
      out.push({
        check: 'empty-state',
        severity: 'warning',
        message: `Content fills only ${Math.round(ratio * 100)}% of the viewport; ${Math.round(probe.empty.largestGapY)}px of unused space sits below it.`,
        location: context.location,
        viewport: context.viewport,
        element: { bounds: probe.empty.region },
        suggestion: 'Either center the block vertically, constrain its max-width and height, or add the content this screen is meant to show.',
        meta: { fillRatio: ratio, gapBelow: probe.empty.largestGapY },
      });
    }
    if (!out.length && context.includePassing) out.push(pass('empty-state', `Content fills ${Math.round(ratio * 100)}% of the viewport.`, context));
    return out;
  }

  private tapTargets(probe: PageProbeResult, context: Context): Finding[] {
    const mobile = (context.viewport ?? '').toLowerCase().includes('mobile') || probe.viewport.width < 700;
    const out: Finding[] = probe.tapTargets.items.slice(0, 12).map((item) => ({
      check: 'tap-targets',
      severity: (mobile ? 'warning' : 'info') as Finding['severity'],
      message: `Tappable ${item.role} is ${item.smallest}px on its shortest side (below ${this.config.review.thresholds.minTapTargetPx}px).`,
      detail: item.name ? `Label: "${truncate(item.name, 50)}"` : undefined,
      location: context.location,
      viewport: context.viewport,
      element: { selector: item.selector, bounds: item.box },
      suggestion: 'Increase padding or line-height on the control itself; avoid relying on margin for hit area.',
    }));
    if (!out.length && context.includePassing) {
      out.push(pass('tap-targets', `All ${probe.tapTargets.checked} interactive elements met the ${this.config.review.thresholds.minTapTargetPx}px target size.`, context));
    }
    return out;
  }

  private overlap(probe: PageProbeResult, context: Context): Finding[] {
    const out: Finding[] = probe.overlaps.items.slice(0, 10).map((item) => ({
      check: 'overlap',
      severity: 'error' as const,
      message: `${item.abovePosition === 'fixed' ? 'A fixed layer' : 'A sticky layer'} covers an interactive element.`,
      detail: `${item.above} (z-index:${item.zIndex}) sits over ${item.below} across ${Math.round(item.area)}px².`,
      location: context.location,
      viewport: context.viewport,
      suggestion: 'Add scroll-padding / bottom padding for the bar height, or lower its z-index; users cannot click what it covers.',
      meta: { area: item.area },
    }));
    if (!out.length && context.includePassing) out.push(pass('overlap', 'No sticky or fixed layer covers interactive content.', context));
    return out;
  }

  private unstyled(probe: PageProbeResult, context: Context): Finding[] {
    const out: Finding[] = [];
    const noCss = probe.stylesheets.rules === 0 && probe.stylesheets.links + probe.stylesheets.inline === 0;
    const serifBody = /times|serif/i.test(probe.palette.font) && !/sans/i.test(probe.palette.font);
    if (noCss && probe.interactiveCount > 0) {
      out.push({
        check: 'unstyled',
        severity: 'error',
        message: 'The page has interactive content but zero applied CSS rules — the stylesheet did not load.',
        detail: `links=${probe.stylesheets.links}, style tags=${probe.stylesheets.inline}${probe.stylesheets.blocked.length ? `, blocked=${probe.stylesheets.blocked.join(', ')}` : ''}`,
        location: context.location,
        viewport: context.viewport,
        suggestion: 'Check the CSS import path and the dev server output; a failed stylesheet request shows under `lens network --problems`.',
      });
    } else if (probe.stylesheets.blocked.length) {
      out.push({
        check: 'unstyled',
        severity: 'warning',
        message: `${pluralize(probe.stylesheets.blocked.length, 'stylesheet')} could not be read (cross-origin or blocked).`,
        detail: probe.stylesheets.blocked.join(', '),
        location: context.location,
        viewport: context.viewport,
      });
    } else if (serifBody && noCss) {
      out.push({
        check: 'unstyled',
        severity: 'warning',
        message: 'Body text is rendering in the default serif font — the design system may not be applied.',
        detail: `font-family: ${probe.palette.font}`,
        location: context.location,
        viewport: context.viewport,
      });
    }
    if (!out.length && context.includePassing) {
      out.push(pass('unstyled', `${probe.stylesheets.rules} CSS rules applied from ${probe.stylesheets.links + probe.stylesheets.inline} sheet(s).`, context));
    }
    return out;
  }

  private focusVisible(probe: PageProbeResult, context: Context): Finding[] {
    if (!probe.focus.hasOutlineNone) {
      return context.includePassing ? [pass('focus-visible', 'No stylesheet removes focus outlines.', context)] : [];
    }
    const sample = probe.focus.samples[0];
    return [
      {
        check: 'focus-visible',
        severity: 'warning',
        message: `${pluralize(probe.focus.removed, 'rule')} removes the focus outline without an equivalent replacement.`,
        detail: sample ? `${sample.selector} { ${sample.text} }` : undefined,
        location: context.location,
        viewport: context.viewport,
        element: sample ? { selector: sample.selector, bounds: sample.box } : undefined,
        suggestion: 'Keyboard users lose their place. Replace `outline:none` with a visible :focus-visible ring (border, box-shadow or outline with offset).',
      },
    ];
  }

  private touchScroll(probe: PageProbeResult, context: Context): Finding[] {
    const mobile = (context.viewport ?? '').toLowerCase().includes('mobile') || probe.viewport.width < 700;
    if (!probe.scroll.locked) {
      return context.includePassing ? [pass('touch-scroll', 'Document scrolling is not locked.', context)] : [];
    }
    if (!mobile && !probe.verticalScroll) return [];
    return [
      {
        check: 'touch-scroll',
        severity: mobile ? 'error' : 'info',
        message: 'Scrolling is locked on html and body, but content is taller than the viewport.',
        detail: `overflow:${probe.scroll.locked.overflow}, height:${probe.scroll.locked.height}, document=${probe.document.scrollHeight}px vs viewport=${probe.viewport.height}px`,
        location: context.location,
        viewport: context.viewport,
        suggestion: 'Content below the fold is unreachable. Move overflow:auto onto the scroll container, or drop the lock on small screens.',
      },
    ];
  }

  private formLabels(probe: PageProbeResult, context: Context): Finding[] {
    const out: Finding[] = probe.labels.items.slice(0, 10).map((item) => ({
      check: 'form-labels',
      severity: 'warning' as const,
      message: `Form control ${item.kind} has no programmatic label.`,
      detail: item.name ? `name="${item.name}"` : undefined,
      location: context.location,
      viewport: context.viewport,
      element: { selector: item.selector, bounds: item.box },
      suggestion: 'Add a <label for>, or aria-label. This breaks screen readers and makes autofill unreliable.',
    }));
    if (!out.length && context.includePassing) out.push(pass('form-labels', 'Every form control has an accessible name.', context));
    return out;
  }

  private altText(probe: PageProbeResult, context: Context): Finding[] {
    const out: Finding[] = probe.alts.items.slice(0, 10).map((item) => ({
      check: 'alt-text',
      severity: 'warning' as const,
      message: `Content image has no alt attribute: ${truncate(item.src, 70)}`,
      location: context.location,
      viewport: context.viewport,
      element: { selector: item.selector, bounds: item.box },
      suggestion: 'Describe the image, or use alt="" if it is purely decorative.',
    }));
    if (probe.alts.missingDecorative > 0) {
      out.push({
        check: 'alt-text',
        severity: 'info',
        message: `${pluralize(probe.alts.missingDecorative, 'small icon')} without alt (likely decorative; alt="" silences them in screen readers).`,
        location: context.location,
        viewport: context.viewport,
      });
    }
    if (!out.length && context.includePassing) out.push(pass('alt-text', 'All content images have alt text.', context));
    return out;
  }

  private textDensity(probe: PageProbeResult, context: Context): Finding[] {
    return probe.density.slice(0, 8).map((item) => ({
      check: 'text-density',
      severity: 'info',
      message: `Line-height ${item.lineHeight}px on ${item.fontSize}px text is tight (ratio ${(item.lineHeight / item.fontSize).toFixed(2)}).`,
      detail: `"${truncate(item.text, 70)}"`,
      location: context.location,
      viewport: context.viewport,
      element: { selector: item.selector, bounds: item.box, style: { fontSize: item.fontSize, lineHeight: item.lineHeight } },
      suggestion: 'Body copy usually wants 1.4–1.6; multi-line text under 1.1 reads as broken.',
    }));
  }

  private consoleFindings(context: Context, sinceSeq: number): Finding[] {
    const collector = this.collectors.console;
    if (!collector) return [];
    const problems = collector.problems(undefined, sinceSeq);
    if (!problems.length) {
      return context.includePassing ? [pass('console', 'No console errors since the last checkpoint.', context)] : [];
    }
    const groups = new Map<string, { count: number; stack?: string; level: string }>();
    for (const entry of problems) {
      const key = truncate(entry.text, 120);
      const existing = groups.get(key);
      if (existing) existing.count += 1;
      else groups.set(key, { count: 1, stack: entry.stack, level: entry.level });
    }
    return [...groups.entries()].map(([text, info]) => ({
      check: 'console' as const,
      severity: (info.level === 'error' ? 'error' : 'warning') as Finding['severity'],
      message: info.count > 1 ? `${pluralize(info.count, 'console error')} reported: ${text}` : `Console ${info.level}: ${text}`,
      detail: info.stack,
      location: context.location,
      viewport: context.viewport,
      suggestion:
        info.level === 'error'
          ? 'Fix the exception before judging the visuals — a thrown error usually leaves the UI half-rendered.'
          : 'Review the warning; framework warnings often point at the exact component to change.',
    }));
  }

  private networkFindings(context: Context, sinceSeq: number): Finding[] {
    const collector = this.collectors.network;
    if (!collector) return [];
    const problems = collector.problems(undefined, sinceSeq);
    if (!problems.length) {
      const slow = collector.summary(undefined, sinceSeq).slow;
      if (slow > 0 && context.includePassing) {
        return [{ check: 'network', severity: 'info', message: `${pluralize(slow, 'slow request')} exceeded ${this.config.network.slowMs}ms.`, location: context.location, viewport: context.viewport }];
      }
      return context.includePassing ? [pass('network', 'No failed or erroring requests.', context)] : [];
    }
    const groups = new Map<string, { count: number; status: (number | null)[]; failure?: string; method: string }>();
    for (const entry of problems) {
      const key = `${entry.method} ${entry.target}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        if (entry.status !== null && !existing.status.includes(entry.status)) existing.status.push(entry.status);
      } else {
        groups.set(key, { count: 1, status: entry.status === null ? [] : [entry.status], failure: entry.failure, method: entry.method });
      }
    }
    return [...groups.entries()].map(([target, info]) => ({
      check: 'network' as const,
      severity: 'error' as const,
      message: info.status.length
        ? `${target} returned HTTP ${info.status.join('/')}${info.count > 1 ? ` (${info.count}x)` : ''}`
        : `${target} failed: ${info.failure ?? 'no response'}`,
      location: context.location,
      viewport: context.viewport,
      suggestion: info.status.some((s) => s !== null && s >= 500)
        ? 'The server rejected this call — check the API logs; the UI is likely showing an error state you should verify too.'
        : 'Confirm the endpoint exists, the dev server is running, and no CORS/origin rule is rejecting it.',
    }));
  }

  private summarize(probe: PageProbeResult, findings: Finding[], verdict: Verdict, context: Context): string {
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const where = context.viewport ? ` at ${context.viewport} (${probe.viewport.width}x${probe.viewport.height})` : ` at ${probe.viewport.width}x${probe.viewport.height}`;
    const head = `${probe.title || probe.url || 'Page'}${where ? ` — ${where}` : ''}`;
    const body =
      verdict === 'pass'
        ? 'No visual problems were detected by the enabled checks. This is a measurement, not a design opinion: spacing, hierarchy and copy still deserve a look at the screenshot.'
        : `${pluralize(errors, 'error')} and ${pluralize(warnings, 'warning')} found.`;
    return `${head}\n${body}`;
  }
}

function pass(check: VisualCheck, message: string, context: Context): Finding {
  return { check, severity: 'pass', message, location: context.location, viewport: context.viewport };
}

function describeCheck(name: VisualCheck, findings: Finding[], probe: PageProbeResult): string {
  if (!findings.length) return 'clean';
  const counts = {
    error: findings.filter((f) => f.severity === 'error').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
    pass: findings.filter((f) => f.severity === 'pass').length,
  };
  if (name === 'contrast') return `${counts.error + counts.warning} low-contrast text nodes (of ${probe.contrast.checked} measured)`;
  if (name === 'layout-overflow') return `${counts.error ? 'document overflows; ' : ''}${probe.overflow.total} element(s) past the edge`;
  if (name === 'clipped-text') return `${probe.clipped.total} clipped container(s)`;
  if (name === 'tap-targets') return `${probe.tapTargets.total} small target(s) of ${probe.tapTargets.checked}`;
  return `${counts.error} error, ${counts.warning} warning, ${counts.info} info, ${counts.pass} pass`;
}

export { computeVerdict };
