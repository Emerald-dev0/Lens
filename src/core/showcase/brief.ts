/**
 * The showcase brief.
 *
 * A recording is a communication artefact, so it needs the same inputs a human
 * presenter would ask for before recording: who is watching, what should be shown,
 * where it will be posted and how long it may run. Lens asks only for the fields
 * that materially change the result and defaults the rest loudly, so an agent can
 * either accept the defaults or ask one focused question.
 */
import { z } from 'zod';

export const PLACEMENTS = ['github-readme', 'docs', 'landing', 'x', 'linkedin', 'internal', 'other'] as const;

export const showcaseBriefSchema = z
  .object({
    /** One sentence: what should the viewer believe after watching? */
    purpose: z.string().min(8),
    /** Who is watching: future users, reviewers, support, a customer. */
    audience: z.string().min(3),
    /** The product being demonstrated, for titles and captions. */
    product: z.string().min(2).default('the product'),
    /** Named features to show, in the order they should appear. */
    features: z.array(z.string().min(2)).min(1),
    placement: z.enum(PLACEMENTS).default('github-readme'),
    durationMs: z.number().int().min(4_000).max(5 * 60_000).default(45_000),
    /** Use obviously-synthetic demo content instead of whatever is on screen. */
    demoData: z.boolean().default(true),
    /** Prefix for generated demo records so they are never mistaken for real data. */
    demoMarker: z.string().default('Demo'),
    labels: z.boolean().default(true),
    narration: z.enum(['none', 'callouts', 'chapters', 'both']).default('both'),
    onScreenText: z
      .object({
        title: z.string().optional(),
        subtitle: z.string().optional(),
        watermark: z.string().optional(),
      })
      .default({}),
    startUrl: z.string().optional(),
    viewport: z.string().default('desktop'),
    format: z.enum(['webm', 'mp4', 'both']).default('both'),
    /** Screens or data that must never appear (billing, real customers, tokens). */
    doNotShow: z.array(z.string()).default([]),
    /** Extra patterns to redact in this recording specifically. */
    sensitive: z.array(z.string()).default([]),
    /** End on the strongest screen rather than wherever the script stops. */
    endOnStrongestScreen: z.boolean().default(true),
    /** Frames of stillness to hold on each beat. */
    dwellMs: z.number().int().min(0).max(6_000).default(900),
  })
  .strict();

export type ShowcaseBrief = z.infer<typeof showcaseBriefSchema>;
export type Placement = (typeof PLACEMENTS)[number];

export interface BriefGap {
  field: keyof ShowcaseBrief | string;
  /** The question an agent should ask, phrased once and answerable in a line. */
  question: string;
  why: string;
  /** What Lens will do if the caller prefers not to answer. */
  fallback: string;
  /** True only when Lens genuinely cannot proceed well without it. */
  blocking: boolean;
}

export interface BriefAssessment {
  complete: boolean;
  gaps: BriefGap[];
  /** Derived from placement: pacing and aspect expectations that follow from it. */
  conventions: Array<{ key: string; value: string; note: string }>;
  notes: string[];
}

const BLOCKING: Array<{ field: keyof ShowcaseBrief; question: string; why: string; fallback: string }> = [
  {
    field: 'purpose',
    question: 'What should a viewer believe after watching this — in one sentence?',
    why: 'The purpose decides which screens are worth the 3 seconds they cost, and what to cut.',
    fallback: 'Assume "show that the core workflow actually works end to end".',
  },
  {
    field: 'audience',
    question: 'Who is watching: prospective users, a reviewer, or support?',
    why: 'A reviewer wants error states and settings; a prospect wants the happy path and polish.',
    fallback: 'Assume a technical evaluator reading the README.',
  },
  {
    field: 'features',
    question: 'Which features should the recording actually show?',
    why: 'Without a list Lens can only tour whatever it finds, which is how demo videos become random clicking.',
    fallback: 'Assume the primary journey the landing page links to, plus one content screen.',
  },
];

const SOFT: Array<{ field: keyof ShowcaseBrief; question: string; why: string; fallback: string }> = [
  {
    field: 'placement',
    question: 'Where will it be posted (README, docs, X)?',
    why: 'README videos should be silent and self-captioned; a launch post can be shorter and punchier.',
    fallback: 'github-readme: silent, captioned, 45s.',
  },
  {
    field: 'durationMs',
    question: 'How long should it run?',
    why: 'Duration is the budget that decides how many beats fit; over 60s most viewers drop out.',
    fallback: '45 seconds.',
  },
  {
    field: 'demoData',
    question: 'Is it fine to type clearly-labelled demo data into the app?',
    why: 'Real customer data in a public recording is unrecoverable once posted; typing nothing leaves empty screens.',
    fallback: 'Yes — synthetic values prefixed with "Demo".',
  },
];

/**
 * Decide what to ask. Deliberately conservative: only three fields are blocking,
 * and even those carry a stated fallback so `lens showcase` never dead-ends.
 */
export function assessBrief(input: Partial<ShowcaseBrief>): BriefAssessment {
  const gaps: BriefGap[] = [];
  const notes: string[] = [];

  const parsed = showcaseBriefSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join('.') || 'brief';
      const known = [...BLOCKING, ...SOFT].find((entry) => entry.field === field);
      if (known) gaps.push({ field, question: known.question, why: known.why, fallback: known.fallback, blocking: BLOCKING.includes(known) });
      else notes.push(`brief.${field}: ${issue.message}`);
    }
  }

  const value = parsed.success ? parsed.data : (input as ShowcaseBrief);
  for (const entry of BLOCKING) {
    const current = (value as Record<string, unknown>)[entry.field];
    const empty = current === undefined || current === '' || (Array.isArray(current) && current.length === 0);
    if (empty) gaps.push({ field: entry.field, question: entry.question, why: entry.why, fallback: entry.fallback, blocking: true });
  }

  if (!value.placement) gaps.push(toGap(SOFT[0]!, true));
  if (!value.durationMs) gaps.push(toGap(SOFT[1]!, false));
  if (value.demoData === undefined) gaps.push(toGap(SOFT[2]!, false));

  if (!parsed.success && parsed.error.issues.some((i) => i.path[0] === 'sensitive' || i.path[0] === 'doNotShow')) {
    notes.push('doNotShow/sensitive accept plain strings (substrings or words to avoid or redact).');
  }

  const conventions = conventionsFor(value.placement ?? 'github-readme', value.durationMs ?? 45_000);
  if (!value.doNotShow?.length && /billing|settings|admin|token/i.test((value.features ?? []).join(' '))) {
    notes.push('The requested features include an account surface; consider doNotShow:["card number","invoice total"] before recording.');
  }
  if (value.demoData !== false && (value.features ?? []).length > 4) {
    notes.push(`More than four features in ${Math.round((value.durationMs ?? 45_000) / 1000)}s means ${Math.round((value.durationMs ?? 45_000) / (value.features!.length + 2) / 100)}s per beat — thin. Drop a feature or add 10 seconds.`);
  }

  return { complete: gaps.filter((g) => g.blocking).length === 0, gaps, conventions, notes };
}

function toGap(entry: { field: keyof ShowcaseBrief; question: string; why: string; fallback: string }, blocking: boolean): BriefGap {
  return { ...entry, blocking };
}

function conventionsFor(placement: Placement, durationMs: number): BriefAssessment['conventions'] {
  const seconds = Math.round(durationMs / 1000);
  switch (placement) {
    case 'github-readme':
      return [
        { key: 'audio', value: 'silent', note: 'README viewers watch muted; every beat needs an on-screen label.' },
        { key: 'length', value: `${Math.min(seconds, 60)}s`, note: 'Above ~60s README viewers skip it; put the strong beat first.' },
        { key: 'aspect', value: '16:9 at 1280–1440px wide', note: 'Readme columns are ~1000px wide; anything smaller gets fuzzy.' },
      ];
    case 'x':
    case 'linkedin':
      return [
        { key: 'length', value: `${Math.min(seconds, 30)}s`, note: 'Feed video holds attention for roughly 15–30s; lead with the payoff.' },
        { key: 'first frame', value: 'a full screen, not a cursor', note: 'Feeds autoplay from the first frame; it is the thumbnail.' },
        { key: 'captions', value: 'required', note: 'Feeds autoplay muted.' },
      ];
    case 'docs':
      return [
        { key: 'pacing', value: 'slower', note: 'Documentation viewers follow along and pause; hold each state longer.' },
        { key: 'labels', value: 'name every control', note: 'Viewers map the words in the guide onto the screen.' },
      ];
    case 'landing':
      return [
        { key: 'polish', value: 'no cursor leftovers', note: 'Marketing surfaces show intentional motion only.' },
        { key: 'length', value: `${Math.min(seconds, 25)}s`, note: 'Looping hero video: short, seamless, no dead frames at the end.' },
      ];
    default:
      return [{ key: 'review', value: 'self-review still applies', note: 'The loop is the same regardless of audience.' }];
  }
}

/** Values typed into the app during a demonstration: obviously synthetic. */
export function demoValue(marker: string, kind: 'name' | 'email' | 'company' | 'text' | 'number' | 'date'): string {
  switch (kind) {
    case 'name':
      return `${marker} Customer`;
    case 'email':
      return `demo@${marker.toLowerCase().replace(/[^a-z0-9]/g, '')}.example`;
    case 'company':
      return `${marker} Industries`;
    case 'text':
      return `${marker}: verified during recording`;
    case 'number':
      return '42';
    case 'date':
      return new Date().toISOString().slice(0, 10);
  }
}

export function normaliseBrief(input: Partial<ShowcaseBrief>): ShowcaseBrief {
  const base: Partial<ShowcaseBrief> = {
    product: 'the product',
    features: [],
    demoData: true,
    labels: true,
    narration: 'both',
    durationMs: 45_000,
    viewport: 'desktop',
    format: 'both',
    placement: 'github-readme',
    doNotShow: [],
    sensitive: [],
    endOnStrongestScreen: true,
    dwellMs: 900,
    demoMarker: 'Demo',
    ...input,
  };
  if (!base.purpose && base.features?.length) base.purpose = `Show how ${base.product} handles ${base.features.join(', ')}`;
  if (!base.audience) base.audience = 'a technical evaluator reading the README';
  const parsed = showcaseBriefSchema.safeParse(base);
  if (parsed.success) return parsed.data;
  throw new Error(`Showcase brief is not usable yet: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}
