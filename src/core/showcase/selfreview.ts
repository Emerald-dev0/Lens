/**
 * Demonstration self-review.
 *
 * "A video file exists" is not the success condition; "a viewer can tell what the
 * product does and that it works" is. This module judges the recording against that
 * bar and returns the *specific* changes that would clear it — the same way a good
 * editor notes "hold the dashboard two seconds longer", not "make it better".
 */
import type { FlowRunResult } from '../flow/run.js';
import type { StopResult } from '../capture/video.js';
import type { Verdict } from '../review/types.js';
import type { ShowcaseBrief } from './brief.js';
import type { ShowcasePlan } from './plan.js';

export interface DemoCheck {
  name: string;
  ok: boolean;
  severity: 'error' | 'warning' | 'info';
  detail: string;
  fix?: string;
}

export interface DemoMetrics {
  targetDurationMs: number;
  actualDurationMs: number;
  frameCoverage: number;
  frames: number;
  fps: number;
  actions: number;
  steps: number;
  chapters: number;
  featuresRequested: number;
  featuresShown: number;
  consoleErrors: number;
  networkFailures: number;
  webmBytes: number | null;
  mp4Bytes: number | null;
}

export interface DemoSelfReview {
  verdict: 'good' | 'revise' | 'poor';
  checks: DemoCheck[];
  metrics: DemoMetrics;
  advice: string[];
  /** Concrete script/brief edits that address the failing checks. */
  revisions: string[];
  summary: string;
}

export interface DemonstrationEvidence {
  brief: ShowcaseBrief;
  plan: ShowcasePlan;
  flow: FlowRunResult;
  recording: StopResult;
  /** Visual verdicts captured during the run, keyed by beat label. */
  reviews?: Array<{ label: string; verdict: Verdict; findings: number }>;
  /** Text that appeared on screen, used only to look for things that must not be shown. */
  visibleText?: string;
  poster?: string | null;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SECRETISH = /\b[A-Za-z0-9_\-]{28,}\b|sk_[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*KEY-----/g;
const CARD = /\b(?:\d[ -]?){13,16}\b/g;

export function reviewDemonstration(evidence: DemonstrationEvidence): DemoSelfReview {
  const { brief, plan, flow, recording } = evidence;
  const checks: DemoCheck[] = [];
  const revisions: string[] = [];
  const advice: string[] = [];

  const chapters = recording.chapters;
  const featuresShown = plan.coverage.shown.filter((feature) => chapters.some((chapter) => chapter.title.toLowerCase().includes(soft(feature)))).length;
  const metrics: DemoMetrics = {
    targetDurationMs: brief.durationMs,
    actualDurationMs: recording.durationMs,
    frameCoverage: recording.coverageRatio,
    frames: Math.max(0, recording.frames),
    fps: recording.fps,
    actions: flow.steps.filter((step) => !step.skipped && step.action !== 'wait' && step.action !== 'expect').length,
    steps: flow.steps.length,
    chapters: chapters.length,
    featuresRequested: plan.coverage.requested.length,
    featuresShown,
    consoleErrors: flow.consoleErrors.length,
    networkFailures: flow.networkFailures.length,
    webmBytes: artifactBytes(recording, 'webm'),
    mp4Bytes: artifactBytes(recording, 'mp4'),
  };

  push(checks, revisions, {
    name: 'duration',
    ok: true,
    severity: 'info',
    detail: '',
  });
  const ratio = metrics.actualDurationMs / Math.max(1, brief.durationMs);
  checks[checks.length - 1] = {
    name: 'duration',
    ok: ratio >= 0.6 && ratio <= 1.4,
    severity: ratio < 0.4 || ratio > 1.8 ? 'error' : 'warning',
    detail: `${seconds(metrics.actualDurationMs)} against a ${seconds(brief.durationMs)} target (${Math.round(ratio * 100)}%)`,
    fix: ratio < 0.6 ? 'Hold each beat longer (raise dwellMs) or add the missing feature beats.' : 'Trim the weakest beat; viewers drop off when a demo over-runs.',
  };
  if (!checks[0]!.ok) revisions.push(ratio < 0.6 ? 'Increase dwellMs by 40% and keep every feature beat.' : 'Drop the lowest-value feature beat.');

  // Pacing: a demo that never rests is unreadable.
  const idleRatio = 1 - recording.coverageRatio;
  checks.push({
    name: 'pacing',
    ok: recording.coverageRatio >= 0.3 && metrics.frames >= Math.max(12, Math.round((metrics.actualDurationMs / 1000) * 3)),
    severity: 'warning',
    detail: `${metrics.frames} frames captured, ${Math.round(recording.coverageRatio * 100)}% of the timeline contains visible change${idleRatio > 0.7 ? ' — mostly static' : ''}`,
    fix:
      metrics.frames < 12
        ? 'Raise the recording frame rate (recording.fps) or lengthen the beats; at this length the video will stutter.'
        : idleRatio > 0.7
          ? 'Too many holds with nothing happening: cut wait steps without a purpose, or make each beat do something visible.'
          : undefined,
  });
  if (!checks[checks.length - 1]!.ok) revisions.push('Reduce pointless waits; every hold should be showing something the viewer needs to read.');

  // Coverage: the brief promised specific features.
  const missing = plan.coverage.missing;
  checks.push({
    name: 'coverage',
    ok: missing.length === 0 && featuresShown >= plan.coverage.requested.length,
    severity: 'error',
    detail: missing.length
      ? `Not shown: ${missing.join(', ')} — no matching screen was found from the start page`
      : `${featuresShown}/${plan.coverage.requested.length} requested features appear as chapters`,
    fix: missing.length ? `Point the demo at the real entry points for: ${missing.join(', ')} (a nav link, a route, or a button label the app actually uses).` : undefined,
  });
  if (!checks[checks.length - 1]!.ok) revisions.push(`Add explicit steps for: ${missing.join(', ') || 'the requested features'} — do not substitute nearby screens.`);

  // Interaction: a demo of a product in use, not a slideshow.
  const featureBeats = plan.beats.filter((beat) => beat.kind === 'feature');
  const beatsWithAction = featureBeats.filter((beat) => beat.steps.some((step) => ['click', 'fill', 'type', 'check', 'select', 'press', 'upload'].includes(step.action ?? ''))).length;
  checks.push({
    name: 'interaction',
    ok: metrics.actions > 0 && beatsWithAction >= Math.max(1, featureBeats.length - (brief.demoData ? 0 : featureBeats.length)),
    severity: 'error',
    detail: `${metrics.actions} interaction(s) across ${featureBeats.length} feature beat(s); ${beatsWithAction} beat(s) perform an action`,
    fix: brief.demoData ? 'Each feature should show the primary control being used (open the dialog, fill the field, save).' : 'Enable demo data so the script can actually operate the product.',
  });
  if (!checks[checks.length - 1]!.ok) revisions.push(brief.demoData ? 'Add a real interaction to each feature beat.' : 'Turn demoData on so beats exercise the UI instead of only viewing it.');

  // No busywork: repeated ping-pong navigation and meaningless scrolling.
  const navs = flow.steps.filter((step) => step.action === 'click' || step.action === 'navigate');
  const labels = navs.map((step) => step.label.toLowerCase());
  let repeated = 0;
  for (let index = 0; index + 2 < labels.length; index += 1) {
    if (labels[index] === labels[index + 2]) repeated += 1;
  }
  const scrolls = flow.steps.filter((step) => step.action === 'scroll').length;
  checks.push({
    name: 'no-busywork',
    ok: repeated === 0 && scrolls <= featureBeats.length,
    severity: 'warning',
    detail: repeated ? `${repeated} repeated A→B→A navigation pattern(s)` : scrolls > featureBeats.length ? `${scrolls} scroll steps for ${featureBeats.length} beats — likely filler` : 'no repeated or filler interactions detected',
    fix: 'Every interaction should communicate something. Remove the ones that only move the mouse.',
  });
  if (!checks[checks.length - 1]!.ok) revisions.push('Delete the repeated navigation and scroll-only steps.');

  // Does the app actually work while being demonstrated?
  checks.push({
    name: 'runtime-health',
    ok: metrics.consoleErrors === 0 && metrics.networkFailures === 0,
    severity: 'error',
    detail:
      metrics.consoleErrors || metrics.networkFailures
        ? `${metrics.consoleErrors} console error(s), ${metrics.networkFailures} failed request(s) during the recording`
        : 'no console errors or failed requests while recording',
    fix: 'Fix the underlying break before re-recording; a demo of a broken flow is worse than no demo.',
  });
  if (!checks[checks.length - 1]!.ok) advice.push('The errors are listed in the flow report with file and line where available.');

  // Visual quality of what was captured.
  const worst = (evidence.reviews ?? []).reduce<{ verdict: Verdict; count: number } | null>((acc, review) => {
    if (!acc) return { verdict: review.verdict, count: review.findings };
    const rank: Record<Verdict, number> = { pass: 0, warn: 1, fail: 2 };
    return rank[review.verdict] > rank[acc.verdict] ? { verdict: review.verdict, count: review.findings } : acc;
  }, null);
  checks.push({
    name: 'visual-quality',
    ok: !worst || worst.verdict !== 'fail',
    severity: 'warning',
    detail: worst ? `worst beat review verdict ${worst.verdict.toUpperCase()} (${worst.count} finding(s))` : 'no per-beat visual review captured',
    fix: worst?.verdict === 'fail' ? 'Fix the layout/console problems first: the recording magnifies them.' : undefined,
  });
  if (worst?.verdict === 'fail') revisions.push('Fix the failing screen, then re-record — never ship a demo of a broken render.');

  // Sensitive information. Lens cannot un-bleed pixels, so this is a hard warning.
  const haystack = evidence.visibleText ?? '';
  const findings: string[] = [];
  if (EMAIL.test(haystack)) findings.push('an email address that is not a demo one');
  EMAIL.lastIndex = 0;
  if (SECRETISH.test(haystack)) findings.push('a long token-like string');
  SECRETISH.lastIndex = 0;
  if (CARD.test(haystack)) findings.push('a card-number-like sequence');
  CARD.lastIndex = 0;
  for (const term of [...brief.doNotShow, ...brief.sensitive]) {
    if (term && haystack.toLowerCase().includes(term.toLowerCase())) findings.push(`"${term}" appeared on screen`);
  }
  checks.push({
    name: 'sensitive-info',
    ok: findings.length === 0,
    severity: 'error',
    detail: findings.length ? `possible exposure: ${findings.join('; ')}` : 'nothing matching sensitive patterns was visible',
    fix: 'Record against seeded demo data, log out of real accounts, and add the pattern to showcase.brief so it is checked next time.',
  });
  if (findings.length) revisions.push('Re-record with demo data only: pixel content cannot be redacted afterwards.');

  // The artefacts themselves.
  checks.push({
    name: 'artifacts',
    ok: Boolean(recording.webm) && (metrics.webmBytes ?? 0) > 8_000 && recording.ok,
    severity: 'error',
    detail: recording.webm
      ? `webm ${humanOrNothing(metrics.webmBytes)}${recording.mp4 ? `, mp4 ${humanOrNothing(metrics.mp4Bytes)}` : ' (no mp4)'}${recording.poster ? ', poster frame' : ''}`
      : 'no video file was produced — frames only',
    fix: recording.webm ? undefined : 'Install ffmpeg (or `npm i -D @ffmpeg-installer/ffmpeg`) and re-run; `lens doctor` shows what Lens looked for.',
  });
  if (!checks[checks.length - 1]!.ok) revisions.push('Make an encoder available so viewers get a real file, not a frame folder.');

  // Ending: the last frame is the impression that sticks.
  const closingStep = [...flow.steps].reverse().find((step) => step.screenshot);
  checks.push({
    name: 'ending',
    ok: Boolean(closingStep?.screenshot) && !recording.chapters.length ? true : Boolean(closingStep?.screenshot),
    severity: 'warning',
    detail: closingStep ? `closes on "${closingStep.label}"` : 'no screenshot at the end — the final frame is whatever the last action left on screen',
    fix: 'End on the strongest screen deliberately: add a closing beat that holds the best view.',
  });
  if (!checks[checks.length - 1]!.ok) revisions.push('Add a closing beat that holds the best screen for ~1.4s.');

  const failing = checks.filter((check) => !check.ok);
  const errors = failing.filter((check) => check.severity === 'error');
  const verdict: DemoSelfReview['verdict'] = errors.length >= 2 || errors.some((c) => c.name === 'sensitive-info' || c.name === 'artifacts') ? 'poor' : failing.length === 0 ? 'good' : 'revise';

  for (const check of failing) if (check.fix) advice.push(`${check.name}: ${check.fix}`);
  if (verdict === 'good') advice.push('Ship it: the loop demonstrates the product working, at the requested length, with the features named.');

  return {
    verdict,
    checks,
    metrics,
    advice,
    revisions: [...new Set(revisions)],
    summary: [
      `Demonstration review: ${verdict.toUpperCase()}`,
      ...checks.map((check) => `  ${check.ok ? '✓' : check.severity === 'error' ? '✗' : '!'} ${check.name}: ${check.detail}`),
    ].join('\n'),
  };
}

function push(checks: DemoCheck[], revisions: string[], check: DemoCheck): void {
  checks.push(check);
  void revisions;
}

function soft(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function artifactBytes(recording: StopResult, kind: 'webm' | 'mp4'): number | null {
  const artifact = recording.artifacts.find((entry) => entry.kind === kind);
  return artifact?.bytes ?? null;
}

function humanOrNothing(bytes: number | null): string {
  if (bytes === null) return 'unavailable';
  return bytes > 1_000_000 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
