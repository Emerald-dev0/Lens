/**
 * Responsive review.
 *
 * Runs the same visual review at every configured viewport profile and reports a
 * verdict per profile. Resizing (not relaunching) is what makes this cheap enough
 * to be a habit instead of a chore.
 */
import path from 'node:path';

import type { ResolvedConfig } from '../config/load.js';
import { resolveViewportProfile, type ViewportProfile } from '../config/load.js';
import type { LensSession } from '../session.js';
import type { Finding, Verdict } from './types.js';
import { computeVerdict } from '../artifacts/report.js';
import { LensError, LensErrorCode } from '../errors.js';
import { ensureDir, safeName, writeJson } from '../util/fs.js';
import { log } from '../util/log.js';

export interface ResponsiveOptions {
  /** Profile names from `responsive.profiles`, or inline `1280x800`. */
  profiles?: string[];
  capture?: 'none' | 'screenshot';
  reload?: boolean;
  includePassing?: boolean;
  /** Extra review checks for this run. */
  checks?: undefined;
}

export interface ViewportResult {
  name: string;
  label: string;
  viewport: ViewportProfile;
  verdict: Verdict;
  findings: Finding[];
  screenshot?: string;
  durationMs: number;
  horizontalOverflow: boolean;
  documentHeight: number;
  error?: { code: string; message: string };
}

export interface ResponsiveRun {
  verdict: Verdict;
  results: ViewportResult[];
  targetUrl: string;
  profileNames: string[];
  durationMs: number;
  summary: string;
  /** The worst viewport, for a one-line headline. */
  headline: string;
  report?: { markdown: string; json: string };
}

export class ResponsiveReviewer {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly session: LensSession,
  ) {}

  async run(options: ResponsiveOptions = {}): Promise<ResponsiveRun> {
    const startedAt = Date.now();
    const names = options.profiles?.length ? options.profiles : this.config.responsive.profiles;
    if (!names.length) {
      throw new LensError({
        code: LensErrorCode.INVALID_INPUT,
        message: 'No responsive viewport profiles are configured.',
        scope: 'input',
        hints: ['Set responsive.profiles in lens.config.json, e.g. ["desktop","tablet","mobile"].'],
      });
    }

    const capture = options.capture ?? this.config.responsive.capture;
    const reload = options.reload ?? this.config.responsive.reload;
    const page = this.session.activePage;
    const urlBefore = page.page.url();
    const results: ViewportResult[] = [];
    const initial = this.session.currentViewport();

    try {
      for (const name of names) {
        const { profile } = resolveViewportProfile(this.config, name);
        const result = await this.measure(name, profile, urlBefore, { capture, reload, includePassing: options.includePassing });
        results.push(result);
      }
    } finally {
      // Always leave the session where the agent found it.
      await this.session.pages.setViewport(initial).catch(() => {});
      await this.session.invalidateAfterResize();
    }

    const verdict = computeVerdict(results.flatMap((r) => r.findings.filter((f) => f.severity === 'error' || f.severity === 'warning')));
    const failing = results.filter((r) => r.verdict !== 'pass');
    const headline = results.length
      ? failing.length === 0
        ? `All ${results.length} viewports pass`
        : `${failing.map((f) => `${f.label} ${f.verdict.toUpperCase()}`).join(', ')} · ${results.length - failing.length} pass`
      : 'No viewports measured';

    const run: ResponsiveRun = {
      verdict,
      results,
      targetUrl: urlBefore,
      profileNames: names,
      durationMs: Date.now() - startedAt,
      summary: summarize(results),
      headline,
    };

    if (this.config.responsive.writeReport) {
      const report = await this.session.writeReport('responsive', {
        title: `Responsive review — ${shorten(urlBefore)}`,
        verdict,
        target: urlBefore,
        durationMs: run.durationMs,
        summary: run.summary,
        findings: results.flatMap((r) => r.findings),
        sections: [
          {
            heading: 'Per viewport',
            lines: results.map((r) => `- ${pad(r.label)} ${r.verdict.toUpperCase()} — ${r.viewport.width}x${r.viewport.height}${r.screenshot ? ` (${path.basename(r.screenshot)})` : ''}`),
          },
        ],
        artifacts: results.filter((r) => r.screenshot).map((r) => ({ path: r.screenshot as string, label: `${r.label} @ ${r.viewport.width}x${r.viewport.height}` })),
        nextActions: nextActionsFor(results),
        data: { results: results.map(({ findings, ...rest }) => ({ ...rest, findings: undefined, findingCount: findings.length })) },
      });
      run.report = { markdown: report.markdown, json: report.json };
    }

    return run;
  }

  private async measure(
    name: string,
    profile: ViewportProfile,
    url: string,
    options: { capture: 'none' | 'screenshot'; reload: boolean; includePassing?: boolean },
  ): Promise<ViewportResult> {
    const startedAt = Date.now();
    const label = profile.label ?? name;
    try {
      await this.session.pages.setViewport(profile);
      if (options.reload) {
        await this.session.activePage.page.reload({ waitUntil: this.config.defaults.waitFor as 'load' }).catch(() => null);
      }
      await this.session.settleAfterResize();

      let screenshot: string | undefined;
      if (options.capture === 'screenshot') {
        const shot = await this.session.screenshot({
          label: `responsive-${safeName(name, 'viewport')}`,
          scope: 'viewport',
          deviceScaleFactor: 1,
        });
        screenshot = path.resolve(this.config.root, shot.path);
      }

      const review = await this.session.review({
        includePassing: options.includePassing,
        viewportName: label,
        location: shorten(url),
      });

      const metrics = await this.session.activePage.page
        .evaluate(() => ({
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          documentHeight: document.documentElement.scrollHeight,
        }))
        .catch(() => ({ horizontalOverflow: false, documentHeight: 0 }));

      return {
        name,
        label,
        viewport: profile,
        verdict: review.verdict,
        findings: review.findings,
        screenshot,
        durationMs: Date.now() - startedAt,
        horizontalOverflow: metrics.horizontalOverflow,
        documentHeight: metrics.documentHeight,
      };
    } catch (err) {
      const error = err instanceof LensError ? err : new LensError({ code: LensErrorCode.REVIEW_FAILED, message: `Viewport ${label} could not be measured.`, scope: 'browser', detail: (err as Error).message, hints: [] });
      log.debug('responsive measure failed', { label, error: error.message });
      return {
        name,
        label,
        viewport: profile,
        verdict: 'fail',
        findings: [{ check: 'responsive', severity: 'error', message: error.message, detail: error.detail, viewport: label, suggestion: error.hints[0] }],
        durationMs: Date.now() - startedAt,
        horizontalOverflow: false,
        documentHeight: 0,
        error: { code: error.code, message: error.message },
      };
    }
  }
}

function summarize(results: ViewportResult[]): string {
  const lines = results.map((r) => `${r.label.padEnd(12)} ${r.verdict.toUpperCase()}`);
  const firstProblem = results.flatMap((r) => r.findings.filter((f) => f.severity === 'error').map((f) => ({ r, f })))[0];
  const tail = firstProblem
    ? `\n\nFirst failure (${firstProblem.r.label}):\n  ${firstProblem.f.message}${firstProblem.f.element?.selector ? `\n  at ${firstProblem.f.element.selector}` : ''}`
    : '';
  return `${lines.join('\n')}${tail}`;
}

function nextActionsFor(results: ViewportResult[]): string[] {
  const failing = results.filter((r) => r.verdict !== 'pass');
  if (!failing.length) return ['Proceed — every configured viewport passed the enabled checks.'];
  const actions = new Set<string>();
  for (const result of failing) {
    const overflow = result.findings.find((f) => f.check === 'layout-overflow' && f.severity === 'error');
    if (overflow) actions.add(`Fix horizontal overflow at ${result.label} (${result.viewport.width}px) — start with the element named in the finding.`);
    const clipped = result.findings.find((f) => f.check === 'clipped-text' && f.severity === 'error');
    if (clipped) actions.add(`Give the clipped text room at ${result.label} — allow wrapping or remove the fixed height.`);
    if (result.findings.some((f) => f.check === 'tap-targets' && f.severity === 'warning')) actions.add(`Increase touch targets at ${result.label} to at least the configured minimum.`);
    if (!overflow && !clipped) actions.add(`Re-run \`lens responsive --profile ${result.name} --screenshot\` after the fix to confirm.`);
  }
  actions.add('Iterate: fix → `lens responsive` → compare until every profile passes.');
  return [...actions];
}

function pad(value: string): string {
  return value.padEnd(12, ' ');
}

function shorten(url: string): string {
  if (!url || url === 'about:blank') return 'no page';
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url.slice(0, 60);
  }
}

export async function writeResponsiveArtifacts(dir: string, run: ResponsiveRun): Promise<string> {
  const target = path.join(dir, 'responsive.json');
  await ensureDir(dir);
  await writeJson(target, run);
  return target;
}
