/**
 * Lens session.
 *
 * One session = one isolated browser + the observation and evidence machinery
 * around it. Everything the CLI, the MCP server and the tests do goes through
 * this class, which is what keeps those interfaces from drifting apart.
 */
import path from 'node:path';

import type { Page } from 'playwright-core';

import { ActionService, type ActionKind, type ActionParams, type ActionResult } from './act/actions.js';
import type { ResolvedConfig } from './config/load.js';
import { resolveViewportProfile } from './config/load.js';
import { ArtifactStore } from './artifacts/paths.js';
import { writeReport } from './artifacts/report.js';
import { SessionLog, type SessionArtifactRef } from './artifacts/session.js';
import { BrowserRuntime, type ManagedPage } from './browser/runtime.js';
import { detectProject, type ProjectProfile } from './detect/project.js';
import { LensError, LensErrorCode, toLensError } from './errors.js';
import { ConsoleCollector } from './observe/console.js';
import { NetworkCollector } from './observe/network.js';
import { SnapshotService, type InteractiveElement, type PageSnapshot, type SnapshotOptions } from './observe/snapshot.js';
import { ScreenshotService, type ElementTarget, type ScreenshotRequest, type ScreenshotResult } from './capture/screenshot.js';
import { OverlayLayer } from './capture/overlay.js';
import { TraceRecorder } from './capture/trace.js';
import { VideoRecorder, type RecordingOptions, type RecordingState, type StopResult } from './capture/video.js';
import { BaselineService } from './review/baseline.js';
import { ResponsiveReviewer, type ResponsiveOptions, type ResponsiveRun } from './review/responsive.js';
import { VisualReviewer, type VisualReviewOptions, type VisualReviewResult } from './review/visual.js';
import { assertNavigationAllowed, describeOrigin, summarizePolicy } from './security/policy.js';
import { log } from './util/log.js';
import { nextId } from './util/fs.js';
import type { BaselineUpdateResult } from './review/baseline.js';
import type { BaselineCompareResult } from './review/baseline.js';

export interface SessionScreenshotRequest extends ScreenshotRequest {
  /** Ref (e.g. `e12`), `css=…`, role/text selector, or element description. */
  element?: string;
  pageId?: string;
}

/** Shape accepted by {@link LensSession.recordAction}. */
export interface ActionResultLike<T> {
  value: T;
  ok?: boolean;
  note?: string;
  error?: unknown;
  artifacts?: SessionArtifactRef[];
}

/** Params are stored in session evidence, so keep bulky values out of them. */
function redactable(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    out[key] = typeof value === 'string' && value.length > 240 ? `${value.slice(0, 240)}…` : value;
  }
  return out;
}

export interface CompareOutcome {
  updated?: BaselineUpdateResult;
  result?: BaselineCompareResult;
  current?: ScreenshotResult;
  suggestion?: string;
}

async function statSize(file: string): Promise<number> {
  try {
    return (await import('node:fs/promises')).stat(file).then((stat) => stat.size, () => 0);
  } catch {
    return 0;
  }
}

export interface SessionInit {
  config: ResolvedConfig;
  entry: 'cli' | 'mcp' | 'api' | 'test';
  version: string;
  /** Resume a named session id instead of minting one. */
  sessionId?: string;
  /** Skip creating the persistent session record (read-only probes). */
  ephemeral?: boolean;
}

export interface OpenResult {
  pageId: string;
  url: string;
  title: string;
  loadTimeMs: number;
  snapshot: PageSnapshot;
  consoleErrors: number;
  networkFailures: number;
  policyNote?: string;
}

export class LensSession {
  readonly store: ArtifactStore;
  readonly console: ConsoleCollector;
  readonly network: NetworkCollector;
  readonly snapshots: SnapshotService;
  readonly actions: ActionService;
  readonly screenshots: ScreenshotService;
  readonly reviewer: VisualReviewer;
  readonly trace: TraceRecorder;
  readonly recorder: VideoRecorder;
  readonly baselines: BaselineService;
  readonly responsive: ResponsiveReviewer;
  /** When true, every action also writes an on-screen callout into the recording. */
  callouts = false;
  private calloutFormat = '{op} {target}';
  private actionsPerformed = 0;
  private readonly overlays: Map<string, Promise<OverlayLayer>> = new Map();

  private runtime!: BrowserRuntime;
  private readonly pageSnapshot = new Map<string, PageSnapshot>();
  private readonly elementRegistry = new Map<string, InteractiveElement>();
  private sessionLogValue: SessionLog | null = null;
  private projectProfileValue: ProjectProfile | null = null;
  private closed = false;
  private startedAt = Date.now();

  private constructor(readonly config: ResolvedConfig, readonly init: SessionInit) {
    this.store = new ArtifactStore(config);
    this.console = new ConsoleCollector(config);
    this.network = new NetworkCollector(config);
    this.snapshots = new SnapshotService(config);
    this.actions = new ActionService(config, this.snapshots, config.root, config.security.uploadDirs ?? []);
    this.screenshots = new ScreenshotService(config, this.store);
    this.reviewer = new VisualReviewer(config, { console: this.console, network: this.network });
    this.trace = new TraceRecorder(config);
    this.recorder = new VideoRecorder({
      config,
      pageFor: (pageId) => this.runtime.page(pageId ?? undefined),
      overlayFor: (pageId) => this.overlay(pageId ?? undefined),
      allocate: (kind, base, ext) => this.store.allocate(kind, base, ext),
      relative: (absolute) => this.store.relative(absolute),
      observationCounts: (pageId, sinceSeq) => ({
        consoleErrors: this.console.problems(pageId ?? undefined, sinceSeq).length,
        networkFailures: this.network.problems(pageId ?? undefined, sinceSeq).length,
      }),
      actionCount: () => this.actionsPerformed,
      trace: this.trace,
    });
    this.baselines = new BaselineService(config);
    this.responsive = new ResponsiveReviewer(config, this);
  }

  /** True when the browser context must be created with Playwright's own recorder. */
  static wantsContextVideo(config: ResolvedConfig): boolean {
    return config.recording.mode === 'context-video';
  }

  static async create(init: SessionInit): Promise<LensSession> {
    const session = new LensSession(init.config, init);
    session.runtime = await BrowserRuntime.start(init.config, {
      events: {
        onPage: (managed) => session.observePage(managed),
        onCrash: (reason) => {
          log.warn('browser reported a crash', { reason });
          session.note(`Crash: ${reason}`);
        },
      },
    });
    session.runtime.projectProfile = await session.detectProject();
    return session;
  }

  /** Attach observation to a tab, including tabs the app opened itself. */
  private observePage(managed: ManagedPage): void {
    this.console.attach(managed.page, managed.id);
    this.network.attach(managed.page, managed.id);
    this.overlays.set(managed.id, OverlayLayer.attach(managed.page));
    this.sessionLogValue?.addPage(managed.page.url());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pages(): BrowserRuntime {
    return this.runtime;
  }

  get activePage(): ManagedPage {
    return this.runtime.requireActivePage();
  }

  page(id?: string): ManagedPage {
    return this.runtime.page(id);
  }

  /** True once at least one tab exists (used by commands that need a live page). */
  get hasPage(): boolean {
    return !this.closed && this.runtime.pageCount > 0;
  }



  get sessionLog(): SessionLog | null {
    return this.sessionLogValue;
  }

  get project(): ProjectProfile | null {
    return this.projectProfileValue;
  }

  private async detectProject(): Promise<ProjectProfile | null> {
    try {
      this.projectProfileValue = await detectProject({ cwd: this.config.root });
      return this.projectProfileValue;
    } catch (err) {
      log.debug('project detection failed', { error: (err as Error).message });
      return null;
    }
  }

  // ------------------------------------------------------------------ session

  async beginSession(options: { target?: string; viewportName?: string } = {}): Promise<SessionLog | null> {
    if (this.init.ephemeral || this.sessionLogValue) return this.sessionLogValue;
    const url = options.target ?? this.runtime.activePage?.page.url() ?? 'about:blank';
    const status = this.runtime.status();
    const origin = describeOrigin(url);
    const profile = resolveViewportProfile(this.config, options.viewportName);
    this.sessionLogValue = await SessionLog.create(this.config, {
      id: this.init.sessionId ?? nextId('lens'),
      entry: this.init.entry,
      version: this.init.version,
      target: { url, origin: origin.origin ?? '', classification: origin.classification },
      viewport: profile.profile,
      browser: {
        engine: status.engine,
        channel: this.config.browser.channel,
        headless: status.headless,
        executable: status.executablePath,
      },
      policy: { mode: summarizePolicy(this.config).mode, allowExternal: this.config.security.allowExternal, redactSensitive: this.config.security.redactSensitive },
    });
    return this.sessionLogValue;
  }

  note(message: string): void {
    this.sessionLogValue?.addNote(message);
  }

  /**
   * Record one unit of work in the session evidence, whatever the caller's shape
   * is. `run` returns the value to hand back plus the fields worth persisting.
   */
  async recordAction<T>(op: string, args: Record<string, unknown> | undefined, run: () => Promise<ActionResultLike<T>>): Promise<T> {
    const log_ = this.sessionLogValue;
    if (!log_) return (await run()).value;
    const handle = log_.startAction(op, args);
    try {
      const outcome = await run();
      await handle.finish({ ok: outcome.ok, artifacts: outcome.artifacts, note: outcome.note, error: outcome.error });
      return outcome.value;
    } catch (err) {
      await handle.finish({ ok: false, error: toLensError(err) });
      throw err;
    }
  }

  // ------------------------------------------------------------------ opening

  async open(target: string, options: { newTab?: boolean; viewport?: string; waitForIdle?: boolean } = {}): Promise<OpenResult> {
    const startedAt = Date.now();
    const url = await this.resolveUrl(target);
    assertNavigationAllowed(this.config, url);

    if (options.viewport) {
      const { profile } = resolveViewportProfile(this.config, options.viewport);
      await this.runtime.setViewport(profile);
    }

    const managed = options.newTab ? await this.runtime.open(url, { reuse: false }) : await this.runtime.open(url, { reuse: true });
    const snapshot = await this.snapshotFor(managed);
    const loadTimeMs = Date.now() - startedAt;

    const consoleProblems = this.console.problems(managed.id);
    const networkProblems = this.network.problems(managed.id);

    return {
      pageId: managed.id,
      url: managed.page.url(),
      title: await managed.page.title().catch(() => ''),
      loadTimeMs,
      snapshot,
      consoleErrors: consoleProblems.length,
      networkFailures: networkProblems.length,
    };
  }

  /** Accept `5173`, `localhost:5173`, `/path`, or a full URL. */
  async resolveUrl(target: string): Promise<string> {
    const value = target.trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;

    const base = await this.resolveBase();
    if (!base) {
      throw new LensError({
        code: LensErrorCode.INVALID_INPUT,
        message: `"${target}" is not a URL, and Lens could not infer a base URL to complete it.`,
        scope: 'input',
        hints: [
          'Pass a full URL: `lens open http://localhost:5173`.',
          'Or configure the dev server: set devServer.url or baseUrl in lens.config.json.',
        ],
      });
    }
    const joined = new URL(value.startsWith('/') ? value : `/${value}`, base).toString();
    return joined;
  }

  private baseCache: { value: string | null; at: number } | null = null;

  /** Pick the app URL: config → env → a live local port from project detection. */
  async resolveBase(): Promise<string | null> {
    if (this.baseCache && Date.now() - this.baseCache.at < 5_000) return this.baseCache.value;
    const config = this.config;
    const explicit = config.baseUrl ?? config.devServer.url ?? process.env.LENS_URL ?? null;
    if (explicit) {
      const value = /^https?:\/\//i.test(explicit) ? explicit : `http://${explicit.replace(/^\/+/, '')}`;
      this.baseCache = { value, at: Date.now() };
      return value;
    }
    const { scanPorts } = await import('./util/net.js');
    const ports = config.devServer.candidatePorts ?? [];
    const open = await scanPorts(ports);
    const value = open.length ? `http://localhost:${String(open[0])}` : null;
    this.baseCache = { value, at: Date.now() };
    return value;
  }

  // -------------------------------------------------------------- observation

  snapshot(pageId?: string): PageSnapshot | null {
    const id = pageId ?? this.runtime.activePageId;
    return id ? (this.pageSnapshot.get(id) ?? null) : null;
  }

  requireSnapshot(pageId?: string): PageSnapshot {
    const existing = this.snapshot(pageId);
    if (existing) return existing;
    throw new LensError({
      code: LensErrorCode.TARGET_STALE,
      message: 'No snapshot has been taken for this page yet, so refs like `e12` do not exist.',
      scope: 'input',
      hints: ['Run `lens snapshot` first — it is also returned automatically by `lens open`.'],
    });
  }

  async snapshotFor(managed: ManagedPage, options: SnapshotOptions = {}): Promise<PageSnapshot> {
    const snapshot = await this.snapshots.capture(managed.page, options);
    this.pageSnapshot.set(managed.id, snapshot);
    for (const element of snapshot.elements) this.elementRegistry.set(`${managed.id}:${element.ref}`, element);
    return snapshot;
  }

  async refreshSnapshot(pageId?: string, options?: SnapshotOptions): Promise<PageSnapshot> {
    return this.snapshotFor(this.runtime.page(pageId), options);
  }

  /** Drop cached snapshots; used after external navigation or a viewport change. */
  invalidateSnapshots(pageId?: string): void {
    if (pageId) this.pageSnapshot.delete(pageId);
    else this.pageSnapshot.clear();
  }

  elementFor(pageId: string, ref: string): InteractiveElement | undefined {
    return this.elementRegistry.get(`${pageId}:${ref}`);
  }

  // ------------------------------------------------------------------- acting

  async act(kind: ActionKind, target: string | null, params: ActionParams = {}, pageId?: string): Promise<ActionResult> {
    const managed = this.runtime.page(pageId);
    await this.assertPageNavigationAllowed(managed.page);
    const before = {
      url: managed.page.url(),
      consoleSeq: this.console.all().at(-1)?.seq ?? 0,
      networkSeq: this.network.all().at(-1)?.seq ?? 0,
    };

    const result = await this.recordAction(kind, { target, ...redactable(params as unknown as Record<string, unknown>) }, async () => {
      const performed = await this.actions.perform(kind, target, params, {
        page: managed.page,
        snapshot: this.pageSnapshot.get(managed.id) ?? null,
        registry: scopedRegistry(this.elementRegistry, managed.id),
        snapshotProvider: () => this.snapshotFor(managed),
      });
      this.actionsPerformed += 1;
      await this.decorateRecording(managed, performed);
      return {
        value: performed,
        ok: true,
        note: `${performed.op} ${performed.element?.name ? `"${performed.element.name}"` : performed.target}${performed.navigated ? ` -> ${performed.url}` : ''}`,
      };
    });

    // A fresh snapshot keeps refs meaningful for the next action without an extra call.
    if (kind !== 'scroll') await this.snapshotFor(managed).catch(() => {});

    const newConsole = this.console.problems(managed.id, before.consoleSeq);
    const newNetwork = this.network.problems(managed.id, before.networkSeq);
    return {
      ...result,
      note:
        result.note +
        (newConsole.length ? ` · ${newConsole.length} new console error(s)` : '') +
        (newNetwork.length ? ` · ${newNetwork.length} failed request(s)` : ''),
      data: {
        ...(result.data ?? {}),
        consoleErrors: newConsole.length,
        networkFailures: newNetwork.length,
        urlBefore: before.url,
      },
    };
  }

  /**
   * Give a running recording something to show for this action: a cursor pulse at
   * the element that was touched, and (when callouts are on) a label naming it.
   */
  private async decorateRecording(managed: ManagedPage, result: ActionResult): Promise<void> {
    if (!this.recorder.active) return;
    try {
      const box = result.element?.box;
      const point = box && box.width >= 0 ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
      await this.recorder.noteAction(point, result.op !== 'scroll' && result.op !== 'press');
      if (this.callouts) {
        const label = this.calloutFormat
          .replace('{op}', result.op)
          .replace('{target}', result.element?.name || result.target || '')
          .trim();
        await this.recorder.callout(label, point ? { at: point } : {});
      }
    } catch (err) {
      log.debug('recording decoration failed', { error: (err as Error).message });
    }
  }

  // ------------------------------------------------------------- recording

  async startRecording(options: RecordingOptions = {}): Promise<RecordingState> {
    return this.recorder.start(options);
  }

  async stopRecording(options: { convert?: boolean; output?: string } = {}): Promise<StopResult> {
    return this.recorder.stop(options);
  }

  recordingStatus(): RecordingState {
    return this.recorder.status();
  }

  async chapter(title: string, note?: string): Promise<void> {
    await this.recorder.chapter(title, note);
  }

  async callout(text: string): Promise<void> {
    await this.recorder.callout(text);
  }

  enableCallouts(format?: string): void {
    this.callouts = true;
    if (format) this.calloutFormat = format;
  }

  // ------------------------------------------------------------- comparisons

  async compare(
    options: {
      baseline?: string;
      update?: boolean;
      /** Promote an existing capture instead of taking a fresh one. */
      from?: string;
      screenshot?: ScreenshotRequest;
      threshold?: number;
      toleranceRatio?: number;
      composite?: boolean;
    } = {},
  ): Promise<CompareOutcome> {
    const name = options.baseline ?? 'default';
    if (options.update) {
      const source = options.from ?? (await this.screenshot({ label: `baseline-${name}`, scope: 'viewport', ...options.screenshot })).path;
      const page = this.runtime.requireActivePage();
      const updated = await this.baselines.update(name, path.resolve(this.config.root, source), {
        url: page.page.url(),
        viewport: this.runtime.currentViewport,
        label: options.screenshot?.label,
        lensVersion: this.init.version,
      });
      this.sessionLogValue?.addArtifact({ path: this.store.relative(updated.path), kind: 'baseline', bytes: (await statSize(updated.path)) });
      return { updated, suggestion: `Baseline "${name}" ${updated.replaced ? 'updated' : 'created'} at ${this.store.relative(updated.path)}.` };
    }

    const current = options.from
      ? { path: path.resolve(this.config.root, options.from) }
      : await this.screenshot({ label: `compare-${name}`, scope: 'viewport', ...options.screenshot });
    const result = await this.baselines.compare(name, current.path, {
      threshold: options.threshold,
      toleranceRatio: options.toleranceRatio,
      composite: options.composite,
    });
    return { result, current: 'label' in current ? (current as ScreenshotResult) : undefined };
  }

  async responsiveReview(options: ResponsiveOptions = {}): Promise<ResponsiveRun> {
    return this.responsive.run(options);
  }

  private async assertPageNavigationAllowed(page: Page): Promise<void> {
    const url = page.url();
    if (!url || url === 'about:blank') return;
    assertNavigationAllowed(this.config, url);
  }

  async navigate(direction: 'back' | 'forward' | 'reload', pageId?: string): Promise<{ url: string; snapshot: PageSnapshot }> {
    const managed = this.runtime.page(pageId);
    const { page } = managed;
    if (direction === 'reload') await page.reload({ waitUntil: this.config.defaults.waitFor as 'load' });
    else if (direction === 'back') await page.goBack({ waitUntil: 'load' }).catch(() => null);
    else await page.goForward({ waitUntil: 'load' }).catch(() => null);
    const snapshot = await this.snapshotFor(managed);
    return { url: page.url(), snapshot };
  }

  async waitFor(condition: { timeMs?: number; selector?: string; text?: string; url?: string; idle?: boolean; pageId?: string }): Promise<{ waited: number; detail: string }> {
    const managed = this.runtime.page(condition.pageId);
    const started = Date.now();
    const timeout = this.config.defaults.navigationTimeoutMs;
    if (condition.selector) {
      await managed.page.waitForSelector(condition.selector, { timeout, state: 'visible' });
    } else if (condition.text) {
      await managed.page.getByText(condition.text).first().waitFor({ timeout, state: 'visible' });
    } else if (condition.url) {
      await managed.page.waitForURL(condition.url, { timeout });
    } else if (condition.idle) {
      await managed.page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 15_000) }).catch(() => {});
      await managed.page.waitForFunction(
        () => document.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle'),
        undefined,
        { timeout: 4000 },
      ).catch(() => {});
    } else if (condition.timeMs) {
      await managed.page.waitForTimeout(condition.timeMs);
    } else {
      throw LensError.usage('`lens wait` needs one of --ms, --selector, --text, --url or --idle.', [
        'Example: lens wait --idle after clicking a button that loads data.',
      ]);
    }
    const waited = Date.now() - started;
    return { waited, detail: condition.selector ?? condition.text ?? condition.url ?? (condition.idle ? 'idle' : `${condition.timeMs}ms`) };
  }

  // ------------------------------------------------------------------ capture

  async screenshot(request: SessionScreenshotRequest = {}, pageId?: string, targetSpec?: string): Promise<ScreenshotResult> {
    const managed = this.runtime.page(pageId ?? request.pageId);
    const spec = targetSpec ?? request.element;
    let element: ElementTarget | undefined;
    if (spec) {
      const resolved = await this.actions.resolveTarget(spec, {
        page: managed.page,
        snapshot: this.pageSnapshot.get(managed.id) ?? null,
        registry: scopedRegistry(this.elementRegistry, managed.id),
        snapshotProvider: () => this.snapshotFor(managed),
      });
      if (resolved.kind === 'point') {
        throw LensError.usage('Element screenshots need an element, not coordinates.', ['Use --element e12 or --element css=… — `lens inspect --box e12` lists refs.']);
      }
      const box = await resolved.locator.boundingBox().catch(() => null);
      if (!box) {
        throw new LensError({
          code: LensErrorCode.TARGET_NOT_VISIBLE,
          message: `${resolved.description} has no bounding box, so it cannot be captured.`,
          scope: 'application',
          hints: ['The element is probably display:none or detached. `lens snapshot` shows what is actually rendered.'],
        });
      }
      element = { locator: resolved.locator, box, description: resolved.description };
    }
    const result = await this.screenshots.capture(managed.page, request, element);
    this.sessionLogValue?.addArtifact({ kind: 'screenshot', path: path.resolve(this.config.root, result.path), label: request.label, bytes: result.bytes, meta: { width: result.width, height: result.height, scope: result.scope } });
    return result;
  }

  async review(options: VisualReviewOptions & { pageId?: string } = {}): Promise<VisualReviewResult> {
    const managed = this.runtime.page(options.pageId);
    return this.reviewer.review(managed.page, options);
  }

  /** The page's overlay layer, created on demand. */
  async overlay(pageId?: string): Promise<OverlayLayer> {
    const managed = this.runtime.page(pageId);
    const existing = this.overlays.get(managed.id);
    if (existing) return existing;
    const created = OverlayLayer.attach(managed.page);
    this.overlays.set(managed.id, created);
    return created;
  }

  // ------------------------------------------------------------ viewport + reports

  currentViewport(): { width: number; height: number; deviceScaleFactor: number } {
    return this.runtime.currentViewport;
  }

  /** Let layout, fonts and any resize-driven JS settle before measuring. */
  async settleAfterResize(): Promise<void> {
    const page = this.runtime.requireActivePage().page;
    await page.waitForTimeout(Math.max(80, this.config.defaults.settleMs)).catch(() => {});
    await page
      .waitForFunction(() => document.fonts?.status === 'loaded' || document.readyState === 'complete', undefined, { timeout: 2000 })
      .catch(() => {});
    await this.refreshSnapshot().catch(() => {});
  }

  async invalidateAfterResize(): Promise<void> {
    this.invalidateSnapshots();
    await this.refreshSnapshot().catch(() => {});
  }

  async setViewport(profile: { width: number; height: number; deviceScaleFactor?: number }): Promise<void> {
    await this.runtime.setViewport(profile);
    await this.invalidateAfterResize();
  }

  /** Paired markdown + JSON report under `.lens/reports`. */
  async writeReport(kind: string, input: Omit<Parameters<typeof writeReport>[1], 'kind'>) {
    return writeReport(this.config, { ...input, kind });
  }

  // --------------------------------------------------------------- lifecycle

  async close(options: { deleteProfile?: boolean } = {}): Promise<{ actions: number; artifacts: number; result: 'success' | 'partial' | 'failed' | 'aborted' }> {
    if (this.closed) return { actions: 0, artifacts: 0, result: 'aborted' };
    this.closed = true;
    const log_ = this.sessionLogValue;
    let result: 'success' | 'partial' | 'failed' | 'aborted' = 'success';
    if (log_) {
      const problems = this.console.problems().length + this.network.problems().length;
      result = problems > 0 ? 'partial' : 'success';
      for (const entry of this.console.problems()) {
        log_.addError({ at: entry.at, source: 'console', severity: entry.level === 'error' ? 'error' : 'warning', message: entry.text.slice(0, 400), url: entry.location?.url });
      }
      for (const entry of this.network.problems()) {
        log_.addError({ at: entry.startedAt, source: 'network', severity: 'error', message: entry.failure ?? `${entry.method} ${entry.target} → ${entry.status ?? 'no response'}`, url: entry.url, status: entry.status ?? undefined });
      }
      log_.setObservations({
        consoleErrors: this.console.summary().errors,
        consoleWarnings: this.console.summary().warnings,
        networkFailures: this.network.summary().failed,
        httpErrors: this.network.summary().httpErrors,
        slowRequests: this.network.summary().slow,
      });
      await log_.finish(result).catch(() => {});
    }
    if (this.recorder.status().backend === 'context-video' || this.recorder.active) {
      await this.recorder.stop({}).catch(() => null);
    }
    const exported = await this.recorder.exportSessionVideo().catch(() => []);
    await this.runtime.close({ deleteProfile: options.deleteProfile }).catch((err) => {
      log.debug('runtime close failed', { error: (err as Error).message });
    });
    for (const artifact of exported) {
      this.sessionLogValue?.addArtifact({ path: artifact.path, kind: 'recording', bytes: artifact.bytes });
    }
    return { actions: log_?.record.actions.length ?? 0, artifacts: log_?.record.artifacts.length ?? 0, result };
  }

  status(): Record<string, unknown> {
    const runtime = this.runtime.status();
    return {
      ...runtime,
      session: this.sessionLogValue?.record.id ?? null,
      startedAt: new Date(this.startedAt).toISOString(),
      policy: summarizePolicy(this.config),
      counts: {
        consoleEntries: this.console.all().length,
        consoleErrors: this.console.summary().errors,
        requests: this.network.all().length,
        networkFailures: this.network.summary().failed + this.network.summary().httpErrors,
        snapshots: this.pageSnapshot.size,
      },
      artifactDir: this.config.artifactDir,
    };
  }
}

function scopedRegistry(registry: Map<string, InteractiveElement>, pageId: string): Map<string, InteractiveElement> {
  const prefix = `${pageId}:`;
  const scoped = new Map<string, InteractiveElement>();
  for (const [key, value] of registry) if (key.startsWith(prefix)) scoped.set(key.slice(prefix.length), value);
  return scoped;
}
