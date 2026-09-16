/**
 * Showcase planning.
 *
 * The plan is built from what the running application *actually offers*: the
 * snapshot's links, headings and controls. That constraint is the whole point — a
 * script assembled from the real UI cannot end up demonstrating a screen that does
 * not exist, and a feature Lens could not find is reported as missing instead of
 * being quietly replaced with something nearby that happened to be on screen.
 */
import type { ResolvedConfig } from '../config/load.js';
import type { LensSession } from '../session.js';
import type { InteractiveElement } from '../observe/snapshot.js';
import type { Flow, FlowStep } from '../flow/schema.js';
import { demoValue, type ShowcaseBrief } from './brief.js';

export interface Beat {
  title: string;
  kind: 'open' | 'feature' | 'action' | 'close';
  rationale: string;
  feature?: string;
  steps: FlowStep[];
  /** How much of the duration budget this beat consumes. */
  weight: number;
}

export interface ShowcasePlan {
  brief: ShowcaseBrief;
  flow: Flow;
  beats: Beat[];
  coverage: { requested: string[]; shown: string[]; missing: string[] };
  warnings: string[];
  estimatedMs: number;
  targetUrl: string;
  /** Screens the plan considered and deliberately rejected. */
  notes: string[];
}

interface Place {
  ref: string;
  name: string;
  role: string;
  href?: string;
  score: number;
  /** Elements on the destination, filled in after a probe visit. */
  destination?: { url: string; heading: string | null; interactive: number; text: string };
}

export async function planShowcase(brief: ShowcaseBrief, session: LensSession, config: ResolvedConfig): Promise<ShowcasePlan> {
  const warnings: string[] = [];
  const notes: string[] = [];
  const start = brief.startUrl ?? '/';
  const opened = await session.open(start);
  const targetUrl = opened.url;

  const snapshot = session.requireSnapshot();
  const places = rankPlaces(snapshot.elements, brief);
  const beats: Beat[] = [];
  const shown: string[] = [];
  const missing: string[] = [];

  // 1. Opening beat: the landing screen, held long enough to read.
  beats.push({
    title: brief.onScreenText.title ?? 'Overview',
    kind: 'open',
    rationale: 'Viewers need one beat to orient before anything moves.',
    weight: 1,
    steps: [
      { action: 'wait', delayMs: Math.round(brief.dwellMs * 0.9), label: 'Hold the opening screen', note: 'No input happens here; the frame is the point.' },
      { action: 'chapter', chapter: brief.onScreenText.title ?? 'Overview', label: 'Chapter: Overview' },
      { action: 'screenshot', label: 'opening', screenshot: 'opening' },
    ],
  });

  // 2. One beat per requested feature, built from a real destination.
  for (const feature of brief.features) {
    const match = bestMatch(feature, places);
    if (!match) {
      const guessed = await probeRoute(session, feature);
      if (!guessed) {
        missing.push(feature);
        notes.push(`No link, heading or route for "${feature}" was found on ${targetUrl}; the beat was dropped rather than substituted.`);
        continue;
      }
      places.push(guessed);
    }
    const place = match ?? (await probeRoute(session, feature))!;
    if (!place) continue;
    shown.push(feature);

    const beat: Beat = {
      title: titleFor(feature, place),
      kind: 'feature',
      feature,
      rationale: `Reached from "${place.name}" (${place.role}${place.href ? ` → ${shortHref(place.href)}` : ''}).`,
      weight: 1.4,
      steps: [],
    };

    beat.steps.push({ action: 'chapter', chapter: beat.title, label: `Chapter: ${beat.title}`, callout: beat.title });
    beat.steps.push({ action: 'click', target: place.ref, label: `Open ${beat.title}`, callout: brief.labels ? `Open ${beat.title}` : undefined, retries: 1, timeoutMs: config.defaults.actionTimeoutMs });
    beat.steps.push({ action: 'wait', delayMs: Math.round(brief.dwellMs * 0.6), label: 'Let the screen settle' });

    // Recon: visit the destination once while planning so the assertion names
    // something true about it. The recorded run still gets there by clicking.
    const destination = place.href ? absolutise(place.href, targetUrl) : place.destination?.url;
    const heading = destination ? firstHeading((await session.open(destination).catch(() => null))?.snapshot.text ?? '') : null;
    if (heading) beat.steps.push({ action: 'expect', label: `${beat.title} renders`, expect: { text: heading.slice(0, 40) } });
    else beat.steps.push({ action: 'expect', label: `${beat.title} renders`, expect: { settled: true, consoleClean: true } });

    if (brief.demoData) {
      const interaction = await findPrimaryInteraction(session, feature);
      if (interaction) {
        beat.steps.push(...interaction.steps);
        beat.rationale += ` Includes ${interaction.summary}.`;
        beat.weight += 0.8;
      } else {
        notes.push(`"${feature}" has no obvious form or primary action to perform; the beat shows the screen only.`);
      }
    }

    beat.steps.push({ action: 'screenshot', label: `feature-${slug(feature)}`, screenshot: `feature-${slug(feature)}`, note: beat.title });
    beats.push(beat);
  }

  // 3. Closing beat on the strongest screen, not wherever the tour stopped.
  const closing = brief.endOnStrongestScreen ? await pickStrongestScreen(session, places) : null;
  beats.push({
    title: closing?.title ?? 'Wrap-up',
    kind: 'close',
    rationale: closing ? 'The most substantial screen the tour found, so the last frame is the best one.' : 'Ends on the final destination; the tour found no clearly stronger screen.',
    weight: 1,
    steps: [
      ...(closing ? [{ action: 'click', target: closing.ref, label: `End on ${closing.title}`, callout: brief.labels ? closing.title : undefined, retries: 1 } as FlowStep] : []),
      { action: 'wait', delayMs: Math.round(brief.dwellMs * 1.4), label: 'Hold the closing screen' },
      { action: 'screenshot', label: 'closing', screenshot: 'closing' },
      { action: 'expect', label: 'Closing screen is healthy', expect: { consoleClean: true, networkClean: true } },
    ],
  });

  const weightTotal = beats.reduce((sum, beat) => sum + beat.weight, 0);
  const perWeight = Math.max(200, Math.round(brief.durationMs / weightTotal));
  for (const beat of beats) {
    const hold = Math.max(200, Math.round(perWeight * beat.weight));
    beat.steps.push({ action: 'wait', delayMs: hold, label: `Pacing hold (${beat.title})`, note: `Holds the frame for ${(hold / 1000).toFixed(1)}s so viewers can read it.` });
  }

  const estimatedMs = beats.reduce((sum, beat) => sum + beat.steps.reduce((total, step) => total + (step.delayMs ?? 250), 0), 0);
  if (estimatedMs > brief.durationMs * 1.25) {
    warnings.push(`The script runs ~${Math.round(estimatedMs / 1000)}s against a ${Math.round(brief.durationMs / 1000)}s target. Drop a feature or raise the duration.`);
  }
  if (missing.length) warnings.push(`Not shown because no route or control was found for: ${missing.join(', ')}.`);
  if (!brief.demoData) warnings.push('demoData=false means nothing is typed: the recording will show read-only screens.');

  await session.open(targetUrl).catch(() => {});

  const flow: Flow = {
    name: `showcase-${slug(brief.purpose)}`,
    description: brief.purpose,
    startUrl: targetUrl,
    viewport: brief.viewport,
    captureEveryStep: false,
    failFast: false,
    steps: beats.flatMap((beat) => beat.steps),
    presentation: {
      title: brief.onScreenText.title,
      subtitle: brief.onScreenText.subtitle,
      callouts: brief.labels,
      chaptersFrom: 'label',
      pacingMs: brief.dwellMs,
      endOnStrongestScreen: brief.endOnStrongestScreen,
    },
    tags: ['showcase', brief.placement],
  };

  return { brief, flow, beats, coverage: { requested: brief.features, shown, missing }, warnings, estimatedMs, targetUrl, notes };
}

function rankPlaces(elements: InteractiveElement[], brief: ShowcaseBrief): Place[] {
  const avoid = brief.doNotShow.map((term) => term.toLowerCase());
  const places: Place[] = [];
  for (const element of elements) {
    if (element.role !== 'link' && element.role !== 'tab' && element.role !== 'menuitem' && element.role !== 'button') continue;
    const name = (element.name ?? '').trim();
    if (name.length < 3) continue;
    const lower = name.toLowerCase();
    if (avoid.some((term) => lower.includes(term))) {
      places.push({ ref: element.ref, name, role: element.role, score: -100 });
      continue;
    }
    let score = 0;
    if (element.role === 'link') score += 3;
    if (element.role === 'tab') score += 2;
    if (/^(sign in|log in|sign up|create account|pricing|changelog|support|docs|home)$/i.test(name)) score -= 4;
    if (/dashboard|projects|overview|reports|inbox|records|analytics|settings/i.test(name)) score += 2;
    if (name.length > 46) score -= 1;
    if (element.inViewport) score += 1;
    places.push({ ref: element.ref, name, role: element.role, href: element.url, score });
  }
  return places.sort((a, b) => b.score - a.score);
}

function bestMatch(feature: string, places: Place[]): Place | null {
  const query = tokens(feature);
  let best: { place: Place; score: number } | null = null;
  for (const place of places) {
    if (place.score < 0) continue;
    const candidate = tokens(place.name);
    let score = 0;
    for (const token of query) {
      if (candidate.includes(token)) score += 3;
      else if (candidate.some((word) => word.startsWith(token.slice(0, Math.max(4, token.length - 2))))) score += 2;
    }
    if (place.name.toLowerCase().includes(feature.toLowerCase())) score += 5;
    if (feature.toLowerCase().includes(place.name.toLowerCase()) && place.name.length > 4) score += 3;
    if (score > 0 && (!best || score > best.score)) best = { place, score };
  }
  return best && best.score >= 2 ? best.place : null;
}

/** Guess a route for a feature name and keep it only if it really renders something new. */
async function probeRoute(session: LensSession, feature: string): Promise<Place | null> {
  const slug = slugOfFeature(feature);
  const bases = [`#/${slug}`, `/${slug}`, `#${slug}`];
  const before = session.requireSnapshot();
  for (const base of bases) {
    const current = session.activePage.page.url().split('#')[0];
    const url = base.startsWith('#') ? `${current}${base}` : new URL(base, current).toString();
    const opened = await session.open(url).catch(() => null);
    if (!opened) continue;
    const after = opened.snapshot;
    const changed = after.url !== before.url || after.text.length > 40;
    const heading = firstHeading(after.text);
    const relevant = heading ? tokens(feature).some((token) => heading.toLowerCase().includes(token)) : true;
    if (changed && relevant && after.elements.length > 1) {
      return { ref: `url:${url}`, name: heading ?? feature, role: 'route', href: url, score: 1, destination: { url, heading, interactive: after.elements.length, text: after.text.slice(0, 400) } };
    }
  }
  await session.open(before.url).catch(() => {});
  return null;
}

/**
 * Find something worth *doing* on a screen: a primary button, then a form.
 * The point is to show the product in use, not to show a static page.
 */
async function findPrimaryInteraction(session: LensSession, feature: string): Promise<{ summary: string; steps: FlowStep[] } | null> {
  const snapshot = session.requireSnapshot();
  const elements = snapshot.elements;
  const primary = elements.find((element) => element.role === 'button' && /new |create |add |send |save|invite|start|generate|upload/i.test(element.name ?? ''));
  if (!primary) return null;

  const steps: FlowStep[] = [];
  const label = (primary.name ?? 'action').replace(/\s+/g, ' ').trim();
  steps.push({ action: 'click', target: primary.ref, label: `${label}`, callout: label, retries: 1 });
  await session.refreshSnapshot().catch(() => {});
  const after = session.requireSnapshot();
  const fields = after.elements.filter((element) => element.role === 'textbox' || element.role === 'combobox' || element.role === 'searchbox');
  if (!fields.length) {
    steps.push({ action: 'expect', label: `${label} produced a response`, expect: { consoleClean: true, settled: true }, optional: true });
    return { summary: `invokes "${label}"`, steps };
  }

  const marker = session.config.showcase.demoMarker ?? 'Demo';
  let typed = 0;
  for (const field of fields.slice(0, 4)) {
    const name = (field.name ?? '').toLowerCase();
    const kind: Parameters<typeof demoValue>[1] = /mail/.test(name) ? 'email' : /company|org|team/.test(name) ? 'company' : /name|contact/.test(name) ? 'name' : /number|count|amount|budget/.test(name) ? 'number' : /date/.test(name) ? 'date' : 'text';
    steps.push({ action: 'fill', target: field.ref, text: demoValue(marker, kind), label: `Type ${field.name ?? 'value'}`, callout: field.name ? `Type ${field.name}` : 'Enter demo data' });
    typed += 1;
  }
  const submit = after.elements.find((element) => element.role === 'button' && /^(save|create|add|submit|confirm|send)$/i.test((element.name ?? '').trim()));
  if (submit) {
    steps.push({ action: 'click', target: submit.ref, label: 'Submit', callout: 'Save the record' });
    steps.push({ action: 'expect', label: 'Submission is accepted', expect: { consoleClean: true, networkClean: true }, optional: false });
  }
  return { summary: typed ? `fills ${typed} field(s) and submits "${label}"` : `opens "${label}"`, steps };
}

async function pickStrongestScreen(session: LensSession, places: Place[]): Promise<{ ref: string; title: string } | null> {
  const candidates = places.filter((place) => place.score > 0 && /dashboard|overview|projects|reports|records|analytics/i.test(place.name));
  const chosen = candidates[0];
  if (!chosen) return null;
  return { ref: chosen.ref, title: chosen.name };
}

function titleFor(feature: string, place: Place): string {
  const clean = place.name.replace(/\s+/g, ' ').trim();
  if (clean.length <= 34 && clean.toLowerCase() !== feature.toLowerCase()) return clean;
  return feature.replace(/\s+/g, ' ').trim();
}

function firstHeading(snapshotText: string): string | null {
  const match = /heading "([^"]{4,90})" level=[123]/.exec(snapshotText);
  return match ? (match[1] as string) : null;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !['the', 'and', 'with', 'for', 'from', 'that', 'this', 'your', 'our'].includes(token));
}

function slugOfFeature(feature: string): string {
  return feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 3).join('-');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'showcase';
}

function shortHref(href: string): string {
  const clean = href.replace(/^https?:\/\/[^/]+/, '');
  return clean.length > 34 ? `${clean.slice(0, 31)}…` : clean;
}

function absolutise(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
