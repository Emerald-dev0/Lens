/**
 * Flow execution.
 *
 * The runner is deliberately boring: it walks the steps in order, does exactly what
 * each one says, checks what it should check, and writes down what happened. All of
 * the intelligence — deciding the steps, reading the failures, fixing the code — is
 * left to the agent that asked for the run.
 *
 * Two properties matter more than anything else here:
 *   • a failing step always leaves evidence (screenshot + the precise check that
 *     failed), never just a stack trace; and
 *   • nothing passes silently. If a step could not be evaluated it is reported as
 *     failed with the reason, not skipped.
 */
import path from 'node:path';

import type { ResolvedConfig } from '../config/load.js';
import { resolveViewportProfile } from '../config/load.js';
import type { LensSession } from '../session.js';
import type { ActionKind } from '../act/actions.js';
import { LensError, LensErrorCode, toLensError } from '../errors.js';
import { computeVerdict } from '../artifacts/report.js';
import type { Verdict } from '../review/types.js';
import { safeName } from '../util/fs.js';
import { log } from '../util/log.js';
import type { Flow, FlowExpectation, FlowStep } from './schema.js';
import { ACTION_KINDS } from './schema.js';

export type FlowPhase = 'before' | 'steps' | 'after';

export interface FlowRunOptions {
  flow: Flow;
  /** Overrides `flow.startUrl`. Relative values resolve against the base URL. */
  url?: string;
  viewport?: string;
  captureEveryStep?: boolean;
  failFast?: boolean;
  /** Prefix for artifact labels. */
  label?: string;
  /** Drive an active recording: pacing, chapters, callouts. */
  showcase?: boolean;
  variables?: Record<string, string>;
  onEvent?: (event: FlowEvent) => void;
}

export interface FlowEvent {
  index: number;
  phase: FlowPhase;
  label: string;
  action: string;
  state: 'start' | 'pass' | 'fail' | 'skip';
  note?: string;
  durationMs?: number;
}

export interface StepCheck {
  kind: string;
  ok: boolean;
  detail: string;
}

export interface StepResult {
  index: number;
  phase: FlowPhase;
  label: string;
  action: string;
  target?: string;
  ok: boolean;
  optional: boolean;
  /** True when the step was not applicable (viewport/env condition). */
  skipped: boolean;
  durationMs: number;
  note?: string;
  checks?: StepCheck[];
  screenshot?: string;
  verdict?: Verdict;
  saved?: Record<string, string>;
  error?: { code: string; message: string; hints?: string[] };
}

export interface FlowRunResult {
  name: string;
  ok: boolean;
  verdict: Verdict;
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  durationMs: number;
  steps: StepResult[];
  startUrl: string | null;
  finalUrl: string | null;
  finalTitle: string | null;
  finalState: { elements: number; scrollHeight: number; viewport: { width: number; height: number } };
  consoleErrors: Array<{ message: string; at: string; pageId: string }>;
  consoleWarnings: number;
  networkFailures: Array<{ method: string; url: string; status: number | null; failure?: string }>;
  screenshots: string[];
  variables: Record<string, string>;
  summary: string;
  nextActions: string[];
  report?: { markdown: string; json: string };
  recording?: { webm?: string; mp4?: string; poster?: string; durationMs?: number };
}

const ACTION_SET = new Set<string>(ACTION_KINDS);

export class FlowRunner {
  private readonly variables: Record<string, string>;
  /** Console/network sequence numbers when the current step began. */
  private stepStartSeq: { console: number; network: number } | null = null;

  constructor(
    private readonly session: LensSession,
    private readonly config: ResolvedConfig,
  ) {
    this.variables = {};
  }

  async run(options: FlowRunOptions): Promise<FlowRunResult> {
    const { flow } = options;
    const startedAt = Date.now();
    const captureEveryStep = options.captureEveryStep ?? flow.captureEveryStep ?? this.config.flows.captureEveryStep;
    const failFast = options.failFast ?? flow.failFast ?? this.config.flows.failFast;
    const pacingMs = options.showcase ? (flow.presentation?.pacingMs ?? 600) : 0;
    Object.assign(this.variables, options.variables ?? {});
    const label = options.label ?? safeName(flow.name, 'flow');

    const results: StepResult[] = [];
    const screenshots: string[] = [];
    const problems: { console: Array<{ message: string; at: string; pageId: string }>; network: Array<{ method: string; url: string; status: number | null; failure?: string }> } = {
      console: [],
      network: [],
    };
    let index = 0;
    let aborted = false;

    const initialViewport = this.session.currentViewport();
    const targetViewport = options.viewport ?? flow.viewport;
    const startedConsoleSeq = this.session.console.all().at(-1)?.seq ?? 0;
    const startedNetworkSeq = this.session.network.all().at(-1)?.seq ?? 0;
    let startUrl: string | null = null;

    try {
      if (targetViewport) {
        const { profile } = resolveViewportProfile(this.config, targetViewport);
        await this.session.setViewport(profile);
      }

      const entry = options.url ?? flow.url ?? flow.startUrl;
      if (entry) {
        const opened = await this.session.open(this.interpolate(entry));
        startUrl = opened.url;
        options.onEvent?.({ index: -1, phase: 'steps', label: `opened ${opened.url}`, action: 'open', state: 'pass', durationMs: opened.loadTimeMs });
      }

      const phases: Array<[FlowPhase, FlowStep[]]> = [
        ['before', flow.before ?? []],
        ['steps', flow.steps],
        ['after', flow.after ?? []],
      ];

      for (const [phase, steps] of phases) {
        for (const step of steps) {
          if (aborted && phase === 'steps') {
            results.push({ index, phase, label: this.describe(step), action: step.action ?? 'act', ok: false, optional: false, skipped: true, durationMs: 0, note: 'not run — an earlier step failed' });
            index += 1;
            continue;
          }
          const result = await this.runStep(step, phase, index, { captureEveryStep, pacingMs, showcase: Boolean(options.showcase), label });
          results.push(result);
          if (result.screenshot) screenshots.push(result.screenshot);
          options.onEvent?.({ index, phase, label: result.label, action: result.action, state: result.skipped ? 'skip' : result.ok ? 'pass' : 'fail', note: result.note, durationMs: result.durationMs });
          if (!result.ok && !result.optional) {
            problems.console.push(...(result.error ? [] : []));
            if (failFast && !this.config.flows.collectAll) aborted = true;
          }
          index += 1;
        }
      }
    } finally {
      if (targetViewport) {
        await this.session.setViewport(initialViewport).catch(() => {});
      }
    }

    for (const entry of this.session.console.problems(undefined, startedConsoleSeq)) {
      problems.console.push({ message: entry.text.slice(0, 300), at: entry.at, pageId: entry.pageId });
    }
    for (const entry of this.session.network.problems(undefined, startedNetworkSeq)) {
      problems.network.push({ method: entry.method, url: entry.url, status: entry.status, failure: entry.failure });
    }

    const failed = results.filter((r) => !r.ok && !r.skipped && !r.optional).length;
    const warned = results.filter((r) => !r.ok && r.optional && !r.skipped).length + results.filter((r) => r.ok && r.checks?.some((c) => !c.ok)).length;
    const skipped = results.filter((r) => r.skipped).length;
    const passed = results.filter((r) => r.ok && !r.skipped).length;

    const finalPage = this.session.activePage.page;
    const finalUrl = finalPage.url();
    const finalTitle = await finalPage.title().catch(() => '');
    const snapshot = this.session.requireSnapshot();
    const verdict: Verdict = failed > 0 ? 'fail' : problems.console.length + problems.network.length > 0 || warned > 0 ? 'warn' : 'pass';

    const result: FlowRunResult = {
      name: flow.name,
      ok: failed === 0,
      verdict,
      passed,
      failed,
      warned,
      skipped,
      durationMs: Date.now() - startedAt,
      steps: results,
      startUrl,
      finalUrl: finalUrl === 'about:blank' ? null : finalUrl,
      finalTitle: finalTitle || null,
      finalState: {
        elements: snapshot?.elements.length ?? 0,
        scrollHeight: snapshot?.scroll.scrollHeight ?? 0,
        viewport: { width: initialViewport.width, height: initialViewport.height },
      },
      consoleErrors: problems.console,
      consoleWarnings: this.session.console.summary().warnings,
      networkFailures: problems.network,
      screenshots,
      variables: { ...this.variables },
      summary: summarize(flow.name, results, problems, verdict),
      nextActions: nextActions(flow, results, problems),
    };

    if (this.config.flows.writeReport !== false) {
      const report = await this.session.writeReport('flow', {
        title: `Flow — ${flow.name}`,
        verdict,
        target: result.finalUrl ?? startUrl ?? undefined,
        durationMs: result.durationMs,
        summary: result.summary,
        findings: results
          .filter((r) => !r.ok && !r.skipped)
          .map((r) => ({
            check: 'flow',
            severity: r.optional ? ('warning' as const) : ('error' as const),
            message: r.error?.message ?? r.note ?? `Step ${r.index + 1} (${r.label}) did not pass`,
            detail: r.checks?.filter((c) => !c.ok).map((c) => `${c.kind}: ${c.detail}`).join('\n'),
            suggestion: `Re-run just this part: \`lens ${r.action === 'expect' ? 'inspect' : r.action}${r.target ? ` "${r.target}"` : ''}\``,
            meta: { step: r.index + 1, action: r.action, label: r.label },
          })),
        sections: [
          {
            heading: 'Steps',
            lines: results.map((r) => `${r.skipped ? '–' : r.ok ? '✓' : '✗'} ${String(r.index + 1).padStart(2, ' ')}. ${r.label}${r.note ? ` — ${r.note}` : ''}${r.screenshot ? ` (${path.basename(r.screenshot)})` : ''}`),
          },
        ],
        artifacts: screenshots.map((file) => ({ path: file, label: 'flow step' })),
        nextActions: result.nextActions,
        data: { flow, result: { ...result, report: undefined } },
      });
      result.report = { markdown: report.markdown, json: report.json };
    }

    return result;
  }

  private describe(step: FlowStep): string {
    return step.label ?? `${step.action ?? 'step'}${step.target ? ` ${step.target}` : ''}`;
  }

  private interpolate(value: string | undefined): string {
    if (!value) return value as string;
    return value.replace(/\$\{(\w+)\}/g, (whole, name: string) => (name in this.variables ? (this.variables[name] as string) : whole));
  }

  private async runStep(
    rawStep: FlowStep,
    phase: FlowPhase,
    index: number,
    ctx: { captureEveryStep: boolean; pacingMs: number; showcase: boolean; label: string },
  ): Promise<StepResult> {
    const startedAt = Date.now();
    this.stepStartSeq = { console: this.session.console.all().at(-1)?.seq ?? 0, network: this.session.network.all().at(-1)?.seq ?? 0 };
    const step = { ...rawStep, target: this.interpolate(rawStep.target), url: this.interpolate(rawStep.url), text: this.interpolate(rawStep.text) } as FlowStep;
    const action = (step.action ?? 'expect') as string;
    const label = this.describe(step);
    const base: StepResult = { index, phase, label, action, target: step.target, ok: true, optional: step.optional ?? false, skipped: false, durationMs: 0 };
    const timeout = step.timeoutMs ?? this.config.flows.stepTimeoutMs ?? this.config.defaults.actionTimeoutMs;

    if (!this.shouldRun(step)) {
      return { ...base, skipped: true, note: 'skipped: `when` condition not met', durationMs: Date.now() - startedAt };
    }

    try {
      const saved: Record<string, string> = {};
      let note: string | undefined;
      const checks: StepCheck[] = [];

      if (step.vars) {
        for (const [key, value] of Object.entries(step.vars)) this.variables[key] = String(value);
        note = `set ${Object.keys(step.vars).join(', ')}`;
      }

      if (action === 'note') {
        note = step.note ?? label;
      }

      if (action === 'wait') {
        const milliseconds = step.delayMs ?? step.amount ?? 400;
        if (step.target) await this.session.waitFor({ selector: stripTargetPrefix(step.target), timeMs: Math.max(timeout, milliseconds) });
        else if (step.text) await this.session.waitFor({ text: step.text, timeMs: Math.max(timeout, milliseconds) });
        else if (step.url) await this.session.waitFor({ url: this.interpolate(step.url), timeMs: Math.max(timeout, milliseconds) });
        else if (milliseconds) await this.session.activePage.page.waitForTimeout(milliseconds);
        note = note ?? `waited ${milliseconds}ms`;
      }

      if (action === 'screenshot') {
        const shot = await this.session.screenshot({ label: typeof step.screenshot === 'string' ? step.screenshot : `${label}-${index}`, scope: 'viewport', animations: 'disabled' });
        base.screenshot = shot.path;
        note = `${shot.width}x${shot.height}`;
      }

      if (action === 'review') {
        const review = await this.session.review({ location: label });
        base.verdict = review.verdict;
        note = `review ${review.verdict} (${review.findings.length} finding${review.findings.length === 1 ? '' : 's'})`;
        if (step.expect?.verdict) checks.push(await this.verdictCheck(review.verdict, step.expect.verdict, label));
      }

      if (action === 'chapter' || (ctx.showcase && step.chapter)) {
        const title = step.chapter ?? label;
        await this.session.chapter(title, step.note);
        note = `chapter "${title}"`;
      }

      if (action === 'navigate') {
        const url = this.interpolate(step.url ?? step.target ?? '');
        if (!url) throw new LensError({ code: LensErrorCode.INVALID_INPUT, message: 'A navigate step needs a url.', scope: 'input', hints: ['{"action":"navigate","url":"/signup"}'] });
        const opened = await this.session.open(url);
        note = `opened ${opened.url} · ${opened.snapshot.elements.length} interactive element(s)`;
      }

      if (ACTION_SET.has(action)) {
        const shot = await this.performAction(step, action as ActionKind, timeout, ctx);
        note = shot.note;
        if (shot.screenshot) base.screenshot = shot.screenshot;
        if (shot.verdict) base.verdict = shot.verdict;
      }

      if (step.save) {
        const value = await this.readForSave(step.save);
        this.variables[step.save.as] = value;
        saved[step.save.as] = value;
        note = `${note ? `${note} · ` : ''}${step.save.as}="${value.slice(0, 60)}"`;
      }

      if (step.expect) {
        checks.push(...(await this.evaluateExpectations(step.expect, `step ${index + 1}`)));
      }

      const failing = checks.filter((c) => !c.ok);
      const ok = failing.length === 0;
      const durationMs = Date.now() - startedAt + (ctx.pacingMs ? 0 : 0);

      if (!ok) {
        const failureShot = base.screenshot ?? (await this.captureFailure(step, index, ctx.label));
        return {
          ...base,
          ok: false,
          durationMs,
          note,
          checks,
          saved: Object.keys(saved).length ? saved : undefined,
          screenshot: failureShot ?? base.screenshot,
          error: {
            code: LensErrorCode.FLOW_STEP_FAILED,
            message: `${label} — ${failing.map((f) => f.detail).join('; ')}`,
            hints: hintsFor(action, step, failing),
          },
        };
      }

      if (ctx.captureEveryStep && !base.screenshot && action !== 'screenshot') {
        const shot = await this.session.screenshot({ label: `${label}-${index}`, scope: 'viewport' }).catch(() => null);
        if (shot) base.screenshot = shot.path;
      }
      if (ctx.pacingMs) await this.session.activePage.page.waitForTimeout(Math.max(0, ctx.pacingMs - Math.min(ctx.pacingMs, durationMs)));

      return { ...base, ok: true, durationMs, note, checks: checks.length ? checks : undefined, saved: Object.keys(saved).length ? saved : undefined };
    } catch (err) {
      const error = toLensError(err);
      const failureShot = await this.captureFailure(step, index, ctx.label);
      return {
        ...base,
        ok: false,
        durationMs: Date.now() - startedAt,
        screenshot: failureShot,
        note: error.hints[0],
        error: { code: error.code, message: error.message, hints: error.hints },
      };
    }
  }

  private async performAction(step: FlowStep, action: ActionKind, timeout: number, ctx: { showcase: boolean; label: string }): Promise<{ note?: string; screenshot?: string; verdict?: Verdict }> {
    const params: Record<string, unknown> = { timeout };
    for (const key of ['text', 'key', 'direction', 'amount', 'to', 'files', 'options', 'clear'] as const) {
      const value = step[key];
      if (value !== undefined) params[key] = this.interpolate(typeof value === 'string' ? value : undefined) ?? value;
    }
    if (step.value !== undefined) {
      params.text = String(step.value);
    }

    let lastError: unknown = null;
    const attempts = 1 + (step.retries ?? 0);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (ctx.showcase && step.callout !== undefined) await this.session.callout(step.callout || this.describe(step));
        const result = await this.session.act(action, step.target ?? null, params as never);
        const shot = typeof step.screenshot === 'string' || step.screenshot === true ? await this.session.screenshot({ label: (typeof step.screenshot === 'string' && step.screenshot) || this.describe(step), scope: 'viewport' }).catch(() => null) : null;
        return {
          note: result.note,
          screenshot: shot?.path,
          verdict: step.review ? (await this.session.review({ location: this.describe(step) })).verdict : undefined,
        };
      } catch (err) {
        lastError = err;
        if (attempt + 1 < attempts) {
          log.debug('flow step retrying', { label: this.describe(step), attempt: attempt + 1, error: (err as Error).message.split('\n')[0] });
          await this.session.refreshSnapshot().catch(() => {});
          await this.session.activePage.page.waitForTimeout(150 * (attempt + 1));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async readForSave(save: NonNullable<FlowStep['save']>): Promise<string> {
    const page = this.session.activePage.page;
    const target = save.target ? stripTargetPrefix(save.target) : null;
    switch (save.from) {
      case 'url':
        return page.url();
      case 'title':
        return await page.title();
      case 'count':
        return String(target ? await page.locator(target).count().catch(() => 0) : 0);
      case 'storage': {
        const value = await page.evaluate((key: string) => {
          try {
            return window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
          } catch {
            return null;
          }
        }, save.target ?? save.as);
        return value ?? '';
      }
      case 'value': {
        if (!target) return '';
        return String(await page.locator(target).inputValue({ timeout: 3000 }).catch(() => ''));
      }
      default: {
        if (!target) return '';
        return (await page.locator(target).innerText({ timeout: 3000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
      }
    }
    // `text` is the default branch above.
  }

  private async evaluateExpectations(expect: FlowExpectation, origin: string): Promise<StepCheck[]> {
    const page = this.session.activePage.page;
    const checks: StepCheck[] = [];
    const snapshot = this.session.requireSnapshot();
    const bodyText = snapshot?.text ?? (await page.locator('body').innerText({ timeout: 3000 }).catch(() => ''));

    if (expect.url) {
      const actual = page.url();
      const ok = matches(actual, expect.url);
      checks.push({ kind: 'url', ok, detail: ok ? `${actual}` : `expected url ${expect.url}, got ${actual}` });
    }
    if (expect.title) {
      const actual = await page.title();
      const ok = matches(actual, expect.title);
      checks.push({ kind: 'title', ok, detail: ok ? `"${actual}"` : `expected title ${expect.title}, got "${actual}"` });
    }
    for (const text of [expect.text].filter((v): v is string => typeof v === 'string')) {
      if (!text) continue;
      const ok = textContains(bodyText, text);
      checks.push({ kind: 'text', ok, detail: ok ? `found "${text}"` : `text "${text}" not present on ${page.url()}` });
    }
    if (expect.textAny?.length) {
      const hit = expect.textAny.find((text) => textContains(bodyText, text));
      checks.push({ kind: 'textAny', ok: Boolean(hit), detail: hit ? `found "${hit}"` : `none of ${expect.textAny.map((t) => `"${t}"`).join(', ')} present` });
    }
    if (expect.notText) {
      const ok = !textContains(bodyText, expect.notText);
      checks.push({ kind: 'notText', ok, detail: ok ? `"${expect.notText}" absent` : `"${expect.notText}" should not appear but does` });
    }
    if (expect.visible) {
      const result = await this.visibility(expect.visible, true);
      checks.push({ kind: 'visible', ok: result.ok, detail: result.detail });
    }
    if (expect.notVisible) {
      const result = await this.visibility(expect.notVisible, false);
      checks.push({ kind: 'notVisible', ok: result.ok, detail: result.detail });
    }
    if (expect.enabled) {
      const locator = this.locatorFor(expect.enabled);
      const disabled = await locator.first().isDisabled({ timeout: 2000 }).catch(() => true);
      checks.push({ kind: 'enabled', ok: !disabled, detail: disabled ? `${expect.enabled} is disabled` : `${expect.enabled} is enabled` });
    }
    if (expect.count) {
      const locator = this.locatorFor(expect.count.target);
      const actual = await locator.count().catch(() => 0);
      const { gte, lte, eq } = expect.count;
      const ok = (eq === undefined || actual === eq) && (gte === undefined || actual >= gte) && (lte === undefined || actual <= lte);
      checks.push({
        kind: 'count',
        ok,
        detail: ok ? `${expect.count.target}: ${actual} element(s)` : `${expect.count.target} count ${actual}, expected ${constraint(gte, lte, eq)}`,
      });
    }
    if (expect.value) {
      const actual = await this.locatorFor(expect.value.target).first().inputValue({ timeout: 3000 }).catch(() => null);
      let ok = true;
      let detail = `value of ${expect.value.target}`;
      if (actual === null) {
        ok = false;
        detail = `${expect.value.target} not found or not an input`;
      } else {
        if (expect.value.equals !== undefined) ok = ok && actual === expect.value.equals;
        if (expect.value.contains !== undefined) ok = ok && actual.includes(expect.value.contains);
        if (expect.value.not !== undefined) ok = ok && !actual.includes(expect.value.not);
        detail = ok ? `${expect.value.target} = "${actual}"` : `${expect.value.target} = "${actual}", expected ${JSON.stringify({ equals: expect.value.equals, contains: expect.value.contains, not: expect.value.not })}`;
      }
      checks.push({ kind: 'value', ok, detail });
    }
    if (expect.attribute) {
      const actual = await this.locatorFor(expect.attribute.target).first().getAttribute(expect.attribute.name, { timeout: 2000 }).catch(() => null);
      const ok = actual === expect.attribute.equals;
      checks.push({ kind: 'attribute', ok, detail: ok ? `${expect.attribute.target}[${expect.attribute.name}]=${actual}` : `${expect.attribute.target}[${expect.attribute.name}] = ${actual ?? '(absent)'}, expected ${expect.attribute.equals}` });
    }
    if (expect.storage) {
      const value = await page.evaluate((key: string) => {
        try {
          return window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key);
        } catch {
          return null;
        }
      }, expect.storage.key);
      let ok = value !== null;
      if (ok && expect.storage.contains !== undefined) ok = String(value).includes(expect.storage.contains);
      if (ok && expect.storage.equals !== undefined) ok = String(value) === expect.storage.equals;
      checks.push({ kind: 'storage', ok, detail: ok ? `localStorage["${expect.storage.key}"] present` : value === null ? `localStorage["${expect.storage.key}"] is empty — the app did not persist the state the step claims` : `localStorage["${expect.storage.key}"] = ${value}` });
    }
    if (expect.settled) {
      const first = page.url();
      await page.waitForTimeout(250);
      const ok = page.url() === first;
      checks.push({ kind: 'settled', ok, detail: ok ? `url stable at ${first}` : `url still moving: ${first} → ${page.url()}` });
    }
    if (expect.consoleClean) {
      const problems = this.session.console.problems(undefined, this.stepStartSeq?.console ?? 0);
      checks.push({ kind: 'consoleClean', ok: problems.length === 0, detail: problems.length === 0 ? 'no console errors' : `${problems.length} console error(s): ${problems.slice(0, 2).map((p) => p.text.split('\n')[0]).join(' | ')}` });
      if (problems.length) {
        const shot = await this.session.screenshot({ label: `console-${safeName(origin, 'flow')}`, scope: 'viewport' }).catch(() => null);
        if (shot) log.debug('console errors during flow', { screenshot: shot.path, count: problems.length });
      }
    }
    if (expect.networkClean) {
      const problems = this.session.network.problems(undefined, this.stepStartSeq?.network ?? 0);
      checks.push({ kind: 'networkClean', ok: problems.length === 0, detail: problems.length === 0 ? 'no failed requests' : `${problems.length} failed request(s): ${problems.slice(0, 2).map((p) => `${p.method} ${p.target}${p.status ? ` ${p.status}` : ''}`).join(' | ')}` });
    }

    return checks;
  }

  private async verdictCheck(actual: Verdict, wanted: 'pass' | 'warn' | 'fail', label: string): Promise<StepCheck> {
    const rank: Record<Verdict, number> = { pass: 0, warn: 1, fail: 2 };
    const ok = rank[actual] <= rank[wanted];
    return { kind: 'verdict', ok, detail: ok ? `${label}: review ${actual} (allowed up to ${wanted})` : `${label}: review verdict is ${actual}, expected at most ${wanted}` };
  }

  private async visibility(target: string, wantVisible: boolean): Promise<{ ok: boolean; detail: string }> {
    const locator = this.locatorFor(target);
    const count = await locator.count().catch(() => 0);
    if (count === 0) return { ok: !wantVisible, detail: wantVisible ? `${target} not found` : `${target} not found (absent, as expected)` };
    const first = locator.first();
    const visible = await first.isVisible({ timeout: 1500 }).catch(() => false);
    const box = wantVisible && visible ? await first.boundingBox().catch(() => null) : null;
    if (wantVisible && !visible) return { ok: false, detail: `${target} exists but is not visible` };
    if (wantVisible && box && (box.width < 2 || box.height < 2)) return { ok: false, detail: `${target} is ${Math.round(box.width)}x${Math.round(box.height)} — effectively invisible` };
    if (!wantVisible && visible) return { ok: false, detail: `${target} is still visible` };
    return { ok: true, detail: wantVisible ? `${target} visible${box ? ` (${Math.round(box.width)}x${Math.round(box.height)})` : ''}` : `${target} not visible` };
  }

  /** Refs (`e12`) go through the session registry; everything else is a Playwright selector. */
  private locatorFor(target: string) {
    const page = this.session.activePage.page;
    const stripped = stripTargetPrefix(target);
    if (/^e\d+$/.test(stripped)) return page.locator(`aria-ref=${stripped}`);
    return page.locator(stripped);
  }

  private async captureFailure(step: FlowStep, index: number, label: string): Promise<string | undefined> {
    const shot = await this.session
      .screenshot({ label: `${label}-step${index + 1}-failed`, scope: 'viewport', annotate: Boolean(step.target) })
      .catch(() => null);
    return shot?.path;
  }

  private shouldRun(step: FlowStep): boolean {
    if (!step.when) return true;
    if (step.when.env && !process.env[step.when.env]) return false;
    if (step.when.hasVariable && !(step.when.hasVariable in this.variables)) return false;
    if (step.when.viewport && this.session.currentViewport().width !== resolveViewportProfile(this.config, step.when.viewport).profile.width) return false;
    return true;
  }
}

function stripTargetPrefix(target: string): string {
  const trimmed = target.trim();
  const match = /^(css|xpath|text|role|label|placeholder|alt|title|testid)[:=](.*)$/is.exec(trimmed);
  if (!match) return trimmed;
  const [, kind = 'css', rest = ''] = match;
  const value = rest.trim();
  switch (kind.toLowerCase()) {
    case 'css':
      return value;
    case 'text':
      return `text=${value}`;
    case 'testid':
      return `[data-testid="${value}"]`;
    case 'role': {
      const [role, name] = value.split(/\s+name=/);
      return name ? `role=${role}[name=${JSON.stringify(name.replace(/^["']|["']$/g, ''))}]` : `role=${role}`;
    }
    case 'label':
      return `label=${value}`;
    case 'placeholder':
      return `[placeholder="${value}"]`;
    case 'alt':
      return `img[alt="${value}"]`;
    case 'title':
      return `[title="${value}"]`;
    case 'xpath':
      return value.startsWith('xpath=') ? value : `xpath=${value}`;
    default:
      return trimmed;
  }
}

function textContains(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const regexLike = /^\/(.+)\/([a-z]*)$/s.exec(needle);
  if (regexLike) {
    try {
      return new RegExp(regexLike[1] as string, regexLike[2]).test(haystack);
    } catch {
      return haystack.includes(needle);
    }
  }
  return haystack.includes(needle);
}

function matches(actual: string, expected: string): boolean {
  return textContains(actual, expected);
}

function constraint(gte?: number, lte?: number, eq?: number): string {
  if (eq !== undefined) return `exactly ${eq}`;
  if (gte !== undefined && lte !== undefined) return `between ${gte} and ${lte}`;
  if (gte !== undefined) return `at least ${gte}`;
  if (lte !== undefined) return `at most ${lte}`;
  return 'a different count';
}

function hintsFor(action: string, step: FlowStep, failing: StepCheck[]): string[] {
  const hints: string[] = [];
  const detail = failing.map((f) => f.detail).join(' ');
  if (/not found/.test(detail)) hints.push(`Confirm the target still exists: \`lens inspect --only interactive\`, then update the flow's target ("${step.target ?? step.expect?.visible ?? ''}").`);
  if (/is not visible/.test(detail)) hints.push('The element exists but is hidden. Either open the panel that contains it first, or assert notVisible.');
  if (/localStorage/.test(detail)) hints.push('The app stores state elsewhere (cookie, in-memory) or the write failed. Check `lens network` for a failed save request.');
  if (action === 'click') hints.push('If the click navigates, assert the destination with `expect.url` instead of the pre-click text.');
  if (/console error/.test(detail)) hints.push('Open the report: the console errors listed there name the failing file and line.');
  if (/failed request/.test(detail)) hints.push('A failed request usually means the dev server route is missing or the payload is rejected — check `lens network --failures`.');
  hints.push(`Re-run only this step to iterate: \`lens test --flow "${step.label ?? action}"\`.`);
  return hints.slice(0, 4);
}

function summarize(name: string, results: StepResult[], problems: { console: unknown[]; network: unknown[] }, verdict: Verdict): string {
  const failed = results.filter((r) => !r.ok && !r.skipped && !r.optional);
  const lines = [`${name}: ${verdict.toUpperCase()} — ${results.filter((r) => r.ok).length}/${results.length} steps passed`];
  for (const step of failed.slice(0, 5)) {
    lines.push(`  ✗ step ${step.index + 1} ${step.label}: ${step.error?.message ?? 'failed'}`);
  }
  if (problems.console.length) lines.push(`  console errors during the run: ${problems.console.length}`);
  if (problems.network.length) lines.push(`  failed requests during the run: ${problems.network.length}`);
  return lines.join('\n');
}

function nextActions(flow: Flow, results: StepResult[], problems: { console: Array<{ message: string }>; network: Array<{ method: string; url: string }> }): string[] {
  const actions: string[] = [];
  const failed = results.filter((r) => !r.ok && !r.skipped && !r.optional);
  for (const step of failed.slice(0, 3)) {
    if (step.error?.hints?.length) actions.push(...step.error.hints.slice(0, 1));
    else actions.push(`Fix step ${step.index + 1} (${step.label}), then re-run \`lens test\`.`);
  }
  if (problems.console.length) actions.push(`Resolve the ${problems.console.length} console error(s) — start with "${((problems.console[0]?.message ?? '').split('\n')[0] ?? '').slice(0, 90)}".`);
  if (problems.network.length) actions.push(`Resolve the ${problems.network.length} failed request(s): ${problems.network.slice(0, 2).map((p) => `${p.method} ${p.url.slice(0, 60)}`).join(', ')}.`);
  if (!actions.length) actions.push('Journey verified end to end. Capture a demonstration with `lens showcase` if the change is user-visible.');
  actions.push('After fixing: `lens test` re-runs the same steps and compares against this report.');
  return [...new Set(actions)];
}
