/**
 * The loop Lens exists for: open a real page, see it, touch it, review it, prove it.
 *
 * These run against the bundled demo application with a real browser. They are the
 * acceptance test for the whole core; if one of them fails the product is broken,
 * not the mock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config/load.js';
import { LensSession } from '../../src/core/session.js';
import { createDemoServer } from '../../fixtures/demo-app/server.mjs';

const PORT = Number(process.env.LENS_E2E_PORT ?? 4317);

let closeServer: () => Promise<void>;
let origin: string;
let config: Awaited<ReturnType<typeof loadConfig>>;
let session: LensSession;

beforeAll(async () => {
  const server = createDemoServer({ port: PORT });
  const started = await server.listen();
  origin = started.url;
  closeServer = started.close;
  config = await loadConfig({ cwd: process.cwd(), overrides: { baseUrl: origin, headless: true, session: { ephemeral: false } } });
  session = await LensSession.create({ config, entry: 'test', version: '0.0.0-e2e' });
  await session.beginSession({ target: origin });
}, 180_000);

afterAll(async () => {
  await session?.close().catch(() => {});
  await closeServer?.();
});

describe('lens core loop', () => {
  it('opens a page and returns a semantic snapshot', async () => {
    const opened = await session.open(`${origin}/`);
    expect(opened.title).toMatch(/Harbor/i);
    expect(opened.snapshot.elements.length).toBeGreaterThan(4);
    expect(opened.consoleErrors).toBe(0);
    expect(opened.networkFailures).toBe(0);
    expect(opened.snapshot.text).toMatch(/heading "Every account[^"]*" level=1/);
  });

  it('captures viewport and element screenshots with real dimensions', async () => {
    const viewport = await session.screenshot({ label: 'e2e-viewport', scope: 'viewport' });
    expect(viewport.width).toBe(config.viewport.width);
    expect(viewport.bytes).toBeGreaterThan(2000);
    const element = await session.screenshot({ label: 'e2e-element', scope: 'element', element: 'css=.topbar' });
    expect(element.height).toBeLessThan(viewport.height);
    expect(fs.existsSync(path.resolve(config.root, viewport.path))).toBe(true);
  });

  it('reviews the healthy page without inventing problems', async () => {
    const review = await session.review({});
    expect(['pass', 'warn']).toContain(review.verdict);
    expect(review.checks.length).toBeGreaterThan(8);
    expect(review.findings.some((f) => f.check === 'broken-images' && f.severity === 'error')).toBe(false);
  });

  it('drives a signup journey with semantic refs', async () => {
    await session.open(`${origin}/#/signup`);
    const snapshot = session.requireSnapshot();
    const byName = (pattern: RegExp, role?: string) =>
      snapshot.elements.find((element) => (role ? element.role === role : true) && pattern.test(element.name ?? ''));

    const fields = ['name', 'email', 'company', 'password'].map((key) => byName(new RegExp(key, 'i')));
    expect(fields.every(Boolean)).toBe(true);
    await session.act('fill', fields[0]!.ref, { text: 'Ada Byron' });
    await session.act('fill', fields[1]!.ref, { text: 'ada@lovelace.dev' });
    await session.act('fill', fields[2]!.ref, { text: 'Analytical Engines' });
    await session.act('fill', fields[3]!.ref, { text: 'counting-stars-42' });

    const submit = byName(/create account/i, 'button')!;
    const result = await session.act('click', submit.ref, {});
    expect(result.via).toMatch(/aria-ref|role|text/);
    await session.waitFor({ idle: true });
    expect(session.activePage.page.url()).toMatch(/#\/dashboard/);
    const signedIn = await session.screenshot({ label: 'e2e-signed-in', scope: 'viewport' });
    expect(signedIn.bytes).toBeGreaterThan(2000);
  });

  it('surfaces console and network problems instead of hiding them', async () => {
    const opened = await session.open(`${origin}/api/metrics?mode=fail`);
    expect(opened.networkFailures).toBeGreaterThanOrEqual(1);
    const review = await session.review({ checks: ['network'] });
    expect(review.findings.some((f) => f.check === 'network')).toBe(true);
    void opened;
  });

  it('detects seeded visual defects in defect mode', async () => {
    await session.open(`${origin}/?defects=1#/dashboard`);
    const review = await session.review({});
    expect(review.verdict).toBe('fail');
    const checks = new Set(review.findings.map((f) => f.check));
    expect(checks.has('layout-overflow') || checks.has('clipped-text')).toBe(true);
    expect(checks.has('broken-images')).toBe(true);
    expect(checks.has('contrast')).toBe(true);
    expect(review.findings.every((f) => Boolean(f.message) && Boolean(f.severity))).toBe(true);
  });

  it('records a session and writes evidence to disk', async () => {
    await session.open(`${origin}/#/`);
    const state = await session.startRecording({ label: 'e2e-recording', fps: 8, mode: 'screencast' });
    expect(state.active).toBe(true);
    await session.chapter('Landing');
    const hero = session.requireSnapshot().elements.find((e) => /create your free account/i.test(e.name ?? ''));
    expect(hero, 'hero CTA should be an inspectable target').toBeTruthy();
    await session.act('hover', hero!.ref, {});
    await pagePause(600);
    await session.act('scroll', null, { direction: 'down', amount: 320 });
    await pagePause(600);
    const stopped = await session.stopRecording({});
    expect(stopped.frames).toBeGreaterThan(2);
    expect(stopped.chapters).toHaveLength(1);
    expect(stopped.webm ? fs.existsSync(stopped.webm) : true).toBe(true);
    if (stopped.webm) {
      const size = fs.statSync(stopped.webm).size;
      expect(size).toBeGreaterThan(1000);
    }
    expect(stopped.manifest && fs.existsSync(stopped.manifest)).toBe(true);
  });

  it('compares against a baseline and reports a change', async () => {
    await session.open(`${origin}/#/pricing`);
    const first = await session.screenshot({ label: 'e2e-baseline', scope: 'viewport', deviceScaleFactor: 1 });
    const updated = await session.compare({ baseline: 'e2e-pricing', from: first.path, update: true });
    expect(fs.existsSync(updated.updated!.path)).toBe(true);

    const unchanged = await session.compare({ baseline: 'e2e-pricing' });
    expect(unchanged.result!.verdict).toBe('match');

    const mutated = await session.activePage.page.evaluate(() => {
      const card = document.querySelector('.tier') as HTMLElement | null;
      if (!card) return false;
      card.style.outline = '8px solid #ff0055';
      card.style.transform = 'translateX(6px)';
      return true;
    });
    expect(mutated, 'the demo pricing page should expose a tier to restyle').toBe(true);
    const changed = await session.compare({ baseline: 'e2e-pricing' });
    expect(changed.result!.verdict).toBe('changed');
    expect(changed.result!.comparison!.changedPixels).toBeGreaterThan(200);
    expect(changed.result!.comparison!.diff).not.toBeNull();
  });

  it('runs a responsive sweep across viewports', async () => {
    await session.open(`${origin}/#/`);
    const run = await session.responsiveReview({ profiles: ['desktop', 'mobile'], capture: 'screenshot' });
    expect(run.results).toHaveLength(2);
    expect(run.results.map((r) => r.viewport.width)).toEqual([1440, 390]);
    expect(run.results.every((r) => r.screenshot && fs.existsSync(r.screenshot))).toBe(true);
    expect(run.headline).toMatch(/pass|FAIL|WARNING/);
  });

  it('writes a session record with actions and artifacts', async () => {
    const closed = await session.close();
    expect(closed.actions).toBeGreaterThan(5);
    const file = path.join(config.artifactPath, 'sessions', session.sessionLog!.record.id, 'session.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(record)).toEqual(expect.arrayContaining(['id', 'target', 'actions', 'screenshots', 'errors', 'networkFailures', 'durationMs', 'result']));
    expect(Array.isArray(record.actions)).toBe(true);
  });
});

async function pagePause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
