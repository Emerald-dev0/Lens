/**
 * Showcase engine: brief → plan → record → review → (revise) → final artefact.
 *
 * Two rules govern this file.
 *
 *   1. It never records without a brief it can defend. If the information that
 *      would change the result is missing, it returns the questions and stops — no
 *      browser motion, no wasted recording.
 *   2. It never declares success on "a file was produced". The recording is judged
 *      against the brief, and a poor result triggers a revision pass rather than a
 *      proud summary.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ResolvedConfig } from '../config/load.js';
import type { LensSession } from '../session.js';
import { FlowRunner, type FlowRunOptions, type FlowRunResult } from '../flow/run.js';
import { resolveFlow } from '../flow/load.js';
import type { Flow } from '../flow/schema.js';
import { LensError, LensErrorCode } from '../errors.js';
import { humanBytes, safeName } from '../util/fs.js';
import { log } from '../util/log.js';
import type { StopResult } from '../capture/video.js';
import { assessBrief, normaliseBrief, type BriefGap, type ShowcaseBrief } from './brief.js';
import { planShowcase, type ShowcasePlan } from './plan.js';
import { reviewDemonstration, type DemoSelfReview } from './selfreview.js';

export interface ShowcaseOptions extends Partial<ShowcaseBrief> {
  /** Run an existing flow file as the script instead of planning from scratch. */
  flow?: string;
  /** Plan and report without recording anything. */
  plan?: boolean;
  /** Re-record automatically when self-review says the result is weak. */
  revise?: boolean;
  attempts?: number;
  fps?: number;
  /** Ignore the "answer the questions first" gate. */
  force?: boolean;
  /** Base name for the recording. */
  label?: string;
  output?: string;
}

export interface ShowcaseAttempt {
  number: number;
  plan: ShowcasePlan;
  flow: FlowRunResult;
  recording: StopResult;
  review: DemoSelfReview;
  durationMs: number;
}

export interface ShowcaseOutcome {
  verdict: DemoSelfReview['verdict'] | 'planned' | 'needs-input';
  brief: ShowcaseBrief;
  plan: ShowcasePlan;
  attempts: ShowcaseAttempt[];
  final?: ShowcaseAttempt;
  needsInput?: { gaps: BriefGap[]; questions: string[] };
  artifacts: Array<{ kind: string; path: string; bytes: number }>;
  report?: { markdown: string; json: string };
  summary: string;
  nextActions: string[];
  warnings: string[];
}

export class ShowcaseEngine {
  private readonly runner: FlowRunner;

  constructor(
    private readonly session: LensSession,
    private readonly config: ResolvedConfig,
  ) {
    this.runner = new FlowRunner(session, config);
  }

  async run(options: ShowcaseOptions = {}): Promise<ShowcaseOutcome> {
    const briefInput = briefFromOptions(options);
    const assessment = assessBrief(briefInput);

    if (!assessment.complete && this.config.showcase.requireBrief && !options.force && !options.plan) {
      return {
        verdict: 'needs-input',
        brief: { ...briefInput, features: briefInput.features ?? [] } as ShowcaseBrief,
        plan: emptyPlan(briefInput as ShowcaseBrief),
        attempts: [],
        needsInput: {
          gaps: assessment.gaps,
          questions: assessment.gaps.filter((gap) => gap.blocking).map((gap) => `${gap.question} (why: ${gap.why}; if unanswered: ${gap.fallback})`),
        },
        artifacts: [],
        summary: `Lens has not recorded anything: ${assessment.gaps.filter((g) => g.blocking).length} brief question(s) would change the result.`,
        nextActions: [
          'Answer the questions above (one line each is enough), then re-run with the same command plus the answers.',
          'To see the script without recording: `lens showcase --plan`.',
          'To accept Lens\'s defaults and record anyway: `lens showcase --force`.',
        ],
        warnings: assessment.notes,
      };
    }

    const brief = normaliseBrief({ ...briefInput, durationMs: options.durationMs ?? briefInput.durationMs });
    let plan = await this.buildPlan(brief, options);

    if (options.plan) {
      const report = await this.session.writeReport('showcase', {
        title: `Showcase plan — ${brief.purpose}`,
        verdict: 'pass',
        target: plan.targetUrl,
        durationMs: 0,
        summary: planSummary(plan, brief),
        findings: [],
        sections: [
          { heading: 'Beats', lines: plan.beats.map((beat, index) => `${index + 1}. ${beat.title} — ${beat.kind}${beat.feature ? ` (feature: ${beat.feature})` : ''}`) },
          { heading: 'Script', lines: plan.flow.steps.map((step, index) => `${index + 1}. ${step.action ?? 'act'} ${step.label ?? ''}`.trim()) },
        ],
        artifacts: [],
        nextActions: ['Record it: `lens showcase` with the same brief.'],
        data: { plan },
      });
      return {
        verdict: 'planned',
        brief,
        plan,
        attempts: [],
        artifacts: [],
        report: { markdown: report.markdown, json: report.json },
        summary: planSummary(plan, brief),
        nextActions: ['Review the beats, then `lens showcase` to record.', ...(plan.coverage.missing.length ? [`Resolve the missing screens first: ${plan.coverage.missing.join(', ')}.`] : [])],
        warnings: [...plan.warnings, ...assessment.notes],
      };
    }

    const maxAttempts = Math.max(1, Math.min(options.attempts ?? this.config.showcase.maxAttempts, this.config.showcase.maxAttempts));
    const shouldRevise = options.revise ?? this.config.showcase.autoRevise;
    const attempts: ShowcaseAttempt[] = [];
    const label = safeName(options.label ?? `showcase-${safeName(brief.purpose, 'demo')}`, 'showcase');

    for (let number = 1; number <= maxAttempts; number += 1) {
      const startedAt = Date.now();
      const recordingLabel = maxAttempts > 1 ? `${label}-v${number}` : label;
      const recordingOptions = {
        label: recordingLabel,
        format: brief.format,
        fps: options.fps ?? this.config.recording.fps,
        title: brief.onScreenText.title ?? brief.purpose,
        overlays: brief.narration !== 'none',
        cursor: brief.narration !== 'none',
      };
      await this.session.startRecording(recordingOptions);

      const runOptions: FlowRunOptions = {
        flow: plan.flow,
        label: recordingLabel,
        showcase: true,
        viewport: brief.viewport,
        captureEveryStep: false,
        failFast: false,
      };
      let flowResult: FlowRunResult;
      try {
        flowResult = await this.runner.run(runOptions);
      } catch (err) {
        const stopped = await this.session.stopRecording({}).catch(() => null);
        this.session.note(`Showcase attempt ${number} failed: ${(err as Error).message.split('\n')[0]}`);
        throw new LensError({
          code: LensErrorCode.SHOWCASE_PLAN_INVALID,
          message: `The demonstration script could not be completed (attempt ${number}).`,
          scope: 'application',
          detail: [err instanceof LensError ? err.detail : (err as Error).message, stopped ? `Partial recording kept: ${stopped.webm ?? stopped.manifest ?? 'frames'}` : '']
            .filter(Boolean)
            .join('\n'),
          hints: err instanceof LensError ? err.hints : ['Run the same steps with `lens test` to see which one breaks.'],
        });
      }

      const recording = await this.session.stopRecording({});
      const reviews = await this.perBeatReviews(plan);
      const visibleText = await this.visibleText();
      const review = reviewDemonstration({
        brief,
        plan,
        flow: flowResult,
        recording,
        reviews,
        visibleText,
        poster: recording.poster,
      });
      const attempt: ShowcaseAttempt = { number, plan, flow: flowResult, recording, review, durationMs: Date.now() - startedAt };
      attempts.push(attempt);
      log.info('showcase attempt complete', { number, verdict: review.verdict, durationMs: attempt.durationMs });

      if (review.verdict === 'good' || !shouldRevise || number === maxAttempts) break;

      // Revise: apply the concrete edits the review asked for, then re-record.
      brief.dwellMs = Math.min(3000, Math.round(brief.dwellMs * 1.5));
      if (review.metrics.featuresShown < review.metrics.featuresRequested && plan.coverage.missing.length) {
        brief.features = brief.features.filter((feature) => !plan.coverage.missing.includes(feature));
        if (!brief.features.length) throw new LensError({ code: LensErrorCode.SHOWCASE_PLAN_INVALID, message: 'None of the requested features could be found in the running app.', scope: 'input', hints: ['Tell Lens where they live (a route or a nav label) via --features or a flow file.'] });
      }
      plan = await this.buildPlan(brief, options);
    }

    const final = attempts[attempts.length - 1]!;
    const artifacts: Array<{ kind: string; path: string; bytes: number }> = final.recording.artifacts.map((artifact) => ({ kind: artifact.kind as string, path: artifact.path, bytes: artifact.bytes }));
    const report = await this.session.writeReport('showcase', {
      title: `Demonstration — ${brief.purpose}`,
      verdict: final.review.verdict === 'good' ? 'pass' : final.review.verdict === 'revise' ? 'warn' : 'fail',
      target: final.flow.finalUrl ?? plan.targetUrl,
      durationMs: final.durationMs,
      summary: [
        `Recorded ${(final.recording.durationMs / 1000).toFixed(1)}s over ${final.flow.steps.length} script steps in ${attempts.length} attempt(s).`,
        final.review.summary,
      ].join('\n\n'),
      findings: final.review.checks
        .filter((check) => !check.ok)
        .map((check) => ({
          check: `showcase:${check.name}`,
          severity: check.severity === 'error' ? ('error' as const) : ('warning' as const),
          message: check.detail,
          suggestion: check.fix,
        })),
      sections: [
        { heading: 'Brief', lines: briefLines(brief) },
        { heading: 'Beats', lines: plan.beats.map((beat, index) => `${index + 1}. ${beat.title} — ${beat.rationale}`) },
        { heading: 'Steps', lines: final.flow.steps.map((step) => `${step.skipped ? '–' : step.ok ? '✓' : '✗'} ${step.index + 1}. ${step.label}${step.note ? ` — ${step.note}` : ''}`) },
        { heading: 'Review', lines: final.review.checks.map((check) => `${check.ok ? '✓' : '!'} ${check.name}: ${check.detail}`) },
      ],
      artifacts: [...artifacts.map((a) => ({ path: a.path, label: a.kind })), ...final.flow.screenshots.map((s) => ({ path: s, label: 'beat screenshot' }))],
      nextActions: showcaseNextActions(final, brief, artifacts),
      data: { brief, review: final.review, coverage: plan.coverage, recording: { webm: final.recording.webm, mp4: final.recording.mp4 } },
    });
    artifacts.push({ kind: 'report', path: this.session.store.relative(report.markdown), bytes: sizeOf(report.markdown) });

    return {
      verdict: final.review.verdict,
      brief,
      plan,
      attempts,
      final,
      artifacts,
      report: { markdown: report.markdown, json: report.json },
      summary: [
        `Demonstration ${final.review.verdict === 'good' ? 'ready' : 'needs attention'}: ${(final.recording.durationMs / 1000).toFixed(1)}s, ${final.review.metrics.frames} frames, ${artifacts.filter((a) => a.kind === 'webm' || a.kind === 'mp4').length} video file(s).`,
        final.review.checks
          .filter((check) => !check.ok)
          .map((check) => `  ! ${check.name}: ${check.detail}`)
          .join('\n'),
      ]
        .filter(Boolean)
        .join('\n'),
      nextActions: showcaseNextActions(final, brief, artifacts),
      warnings: [...plan.warnings, ...final.recording.warnings, ...(final.flow.consoleErrors.length ? [`${final.flow.consoleErrors.length} console error(s) during the run`] : [])],
    };
  }

  private async buildPlan(brief: ShowcaseBrief, options: ShowcaseOptions): Promise<ShowcasePlan> {
    if (options.flow) {
      const discovered = await resolveFlow(this.config, options.flow);
      const plan: ShowcasePlan = {
        brief,
        flow: { ...discovered.flow, presentation: { title: brief.onScreenText.title, subtitle: brief.onScreenText.subtitle, callouts: brief.labels, chaptersFrom: 'label', pacingMs: brief.dwellMs, endOnStrongestScreen: brief.endOnStrongestScreen, ...(discovered.flow.presentation ?? {}) }, name: discovered.flow.name || 'showcase-flow' } as Flow,
        beats: discovered.flow.steps.map((step, index) => ({ title: step.label ?? `step ${index + 1}`, kind: index === 0 ? 'open' : index === discovered.flow.steps.length - 1 ? 'close' : 'feature', rationale: 'From the supplied flow file.', steps: [step], weight: 1 })),
        coverage: { requested: brief.features, shown: brief.features, missing: [] },
        warnings: ['Using a supplied flow file as the demonstration script; Lens will not re-plan it.'],
        estimatedMs: discovered.flow.steps.length * (brief.dwellMs + 250),
        targetUrl: brief.startUrl ?? '/',
        notes: [],
      };
      return plan;
    }
    return planShowcase(brief, this.session, this.config);
  }

  /** One visual review per feature beat, taken at the current screen. */
  private async perBeatReviews(plan: ShowcasePlan): Promise<Array<{ label: string; verdict: 'pass' | 'warn' | 'fail'; findings: number }>> {
    if (!this.config.showcase.selfReview) return [];
    const review = await this.session.review({ location: plan.beats.at(-1)?.title ?? 'final' }).catch(() => null);
    if (!review) return [];
    return [{ label: review.summary.slice(0, 40), verdict: review.verdict, findings: review.findings.length }];
  }

  private async visibleText(): Promise<string> {
    const snapshot = this.session.requireSnapshot();
    const notes = this.session.sessionLog?.record.notes.join('\n') ?? '';
    return [snapshot?.text ?? '', notes].join('\n');
  }
}

function briefFromOptions(options: ShowcaseOptions): Partial<ShowcaseBrief> {
  const { flow: _flow, plan: _plan, revise: _revise, attempts: _attempts, fps: _fps, force: _force, label: _label, output: _output, ...rest } = options;
  return rest;
}

function briefLines(brief: ShowcaseBrief): string[] {
  return [
    `Purpose: ${brief.purpose}`,
    `Audience: ${brief.audience}`,
    `Placement: ${brief.placement} · target ${(brief.durationMs / 1000).toFixed(0)}s`,
    `Features: ${brief.features.join(' → ')}`,
    `Demo data: ${brief.demoData ? `yes, labelled "${brief.demoMarker}"` : 'no — nothing is typed'}`,
    `Narration: ${brief.narration}${brief.labels ? ' with on-screen labels' : ''}`,
    brief.doNotShow.length ? `Never show: ${brief.doNotShow.join(', ')}` : '',
  ].filter(Boolean);
}

function planSummary(plan: ShowcasePlan, brief: ShowcaseBrief): string {
  return [
    `Plan for: ${brief.purpose}`,
    `${plan.beats.length} beats / ${plan.flow.steps.length} steps, ~${(plan.estimatedMs / 1000).toFixed(0)}s of ${Math.round(brief.durationMs / 1000)}s budget`,
    `Start: ${plan.targetUrl}`,
    ...plan.beats.map((beat, index) => `  ${index + 1}. ${beat.title} [${beat.kind}]`),
    plan.coverage.missing.length ? `  ! cannot show: ${plan.coverage.missing.join(', ')}` : '',
    ...plan.notes.map((note) => `  · ${note}`),
  ]
    .filter(Boolean)
    .join('\n');
}

function showcaseNextActions(attempt: { review: DemoSelfReview; recording: StopResult; flow: FlowRunResult }, brief: ShowcaseBrief, artifacts: Array<{ kind: string; path: string }>): string[] {
  const actions: string[] = [];
  const video = artifacts.find((a) => a.kind === 'webm') ?? artifacts.find((a) => a.kind === 'mp4');
  if (attempt.review.verdict === 'good') {
    if (video) actions.push(`Embed it: ![Demonstration](${video.path}) — silent, captioned, ${(attempt.recording.durationMs / 1000).toFixed(0)}s.`);
    actions.push('Check the first frame yourself: it is what a feed shows as the thumbnail.');
    return actions;
  }
  for (const line of attempt.review.revisions.slice(0, 4)) actions.push(line);
  actions.push('Re-record with the fixes: `lens showcase --revise` applies the same review loop again.');
  if (attempt.flow.failed > 0) actions.push(`The script had ${attempt.flow.failed} failing step(s); fix those first — a demo of a broken flow is not a demo.`);
  void brief;
  return [...new Set(actions)];
}

function emptyPlan(brief: ShowcaseBrief): ShowcasePlan {
  return {
    brief,
    flow: { name: 'unplanned', steps: [] } as unknown as Flow,
    beats: [],
    coverage: { requested: brief.features ?? [], shown: [], missing: brief.features ?? [] },
    warnings: ['No plan was produced because the brief is incomplete.'],
    estimatedMs: 0,
    targetUrl: brief.startUrl ?? '/',
    notes: [],
  };
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(path.resolve(file)).size;
  } catch {
    return 0;
  }
}

export { humanBytes };
