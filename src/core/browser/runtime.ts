/**
 * Browser runtime.
 *
 * Owns the Lens-controlled browser: a dedicated, isolated Chromium instance with
 * its own user-data-dir under `.lens/profiles`. It never attaches to the user's
 * real browser, and every page is registered under a stable id (`p1`, `p2`, …)
 * so an agent can talk about tabs without holding object references.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  chromium,
  devices,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Download,
  type Page,
} from 'playwright-core';

import type { ResolvedConfig } from '../config/load.js';
import { LensError, LensErrorCode } from '../errors.js';
import { ensureDir, humanDuration, removeTree } from '../util/fs.js';
import { provisionPlaywrightFfmpeg } from '../capture/ffmpeg.js';
import { log } from '../util/log.js';
import { probeUrl } from '../util/net.js';
import type { ProjectProfile } from '../detect/project.js';
import { devServerHints } from '../detect/project.js';
import { assertNavigationAllowed } from '../security/policy.js';
import { provisionBrowser, type ProvisionedBrowser } from './provision.js';

/** Progressively safer launch profiles (verified against stripped-down Chromium builds). */
const LAUNCH_PROFILES: Array<{ id: string; args: string[] }> = [
  { id: 'default', args: ['--no-sandbox', '--disable-dev-shm-usage'] },
  { id: 'software-safe', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer', '--use-gl=disabled'] },
  { id: 'container', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer', '--use-gl=disabled', '--single-process', '--no-zygote'] },
];

export interface ManagedPage {
  id: string;
  page: Page;
  createdAt: string;
  /** Set when the tab was opened by the app (popup/target) rather than by Lens. */
  origin: 'lens' | 'popup';
  /** Renderer-only failures are scoped to the page, not the whole browser. */
  crashed?: boolean;
  crashReason?: string;
}

export interface LaunchResult {
  profileId: string;
  attempts: Array<{ profileId: string; ok: boolean; error?: string; durationMs: number }>;
  browser: ProvisionedBrowser;
  durationMs: number;
  version: string;
}

export interface RuntimeStatus {
  running: boolean;
  engine: string;
  headless: boolean;
  launchProfile: string;
  browserLabel: string;
  executablePath: string;
  version: string;
  profileDir: string;
  pid: number | null;
  startedAt: string;
  uptimeMs: number;
  pages: number;
  crashed: boolean;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  storageStatePath: string | null;
}

export interface RuntimeEvents {
  onPage?: (managed: ManagedPage) => void;
  onClose?: (pageId: string) => void;
  onDownload?: (pageId: string, download: Download) => void;
  onDialog?: (pageId: string, dialog: { type: string; message: string; accepted: boolean }) => void;
  onCrash?: (reason: string) => void;
}

export class BrowserRuntime {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly pages = new Map<string, ManagedPage>();
  private pageSeq = 0;
  private activePageIdValue: string | null = null;
  private crashed = false;
  private crashReason: string | null = null;
  private readonly startedAt = new Date().toISOString();
  private launch: LaunchResult | null = null;
  private viewport: { width: number; height: number; deviceScaleFactor: number };
  private storageStatePath: string | null = null;
  private downloads: Array<{ pageId: string; suggested: string; path: string | null; at: string }> = [];
  private readonly cdpSessions = new Map<string, import('playwright-core').CDPSession>();

  readonly events: RuntimeEvents;

  private constructor(
    readonly config: ResolvedConfig,
    readonly profileDir: string,
    events: RuntimeEvents = {},
  ) {
    this.events = events;
    this.viewport = {
      width: config.viewport.width,
      height: config.viewport.height,
      deviceScaleFactor: config.viewport.deviceScaleFactor,
    };
  }

  /** Create a runtime and launch the browser. */
  static async start(config: ResolvedConfig, options: { events?: RuntimeEvents; profileDir?: string } = {}): Promise<BrowserRuntime> {
    const profileDir = options.profileDir ?? path.join(config.artifactPath, 'profiles', `p${process.pid}`);
    await ensureDir(profileDir);
    const runtime = new BrowserRuntime(config, profileDir, options.events);
    await runtime.launchBrowser();
    return runtime;
  }

  /** Attach to an already-running runtime description (used by tests/tooling). */
  static fromHandle(config: ResolvedConfig, handle: { browser: Browser; context: BrowserContext; profileDir: string; launch: LaunchResult }): BrowserRuntime {
    const runtime = new BrowserRuntime(config, handle.profileDir);
    runtime.browser = handle.browser;
    runtime.context = handle.context;
    runtime.launch = handle.launch;
    return runtime;
  }

  private async launchBrowser(): Promise<void> {
    const config = this.config;
    const started = Date.now();
    const provisioned = await provisionBrowser({ browser: config.browser, root: config.root });
    const engineName = config.browser.engine;
    if (engineName !== 'chromium' && provisioned.source === 'npm-package') {
      throw new LensError({
        code: LensErrorCode.BROWSER_NOT_FOUND,
        message: `browser.engine "${engineName}" has no runtime available.`,
        scope: 'environment',
        detail: 'Lens provisions Chromium from node_modules; Firefox/WebKit require a Playwright-managed install.',
        hints: [`Run \`npx playwright install ${engineName}\`, or set browser.engine to "chromium".`],
      });
    }

    const typeMap = { chromium, firefox, webkit } as const;
    const browserType = typeMap[engineName] ?? chromium;

    const attempts: LaunchResult['attempts'] = [];
    const profiles = config.browser.launchFallbacks === false ? LAUNCH_PROFILES.slice(0, 1) : LAUNCH_PROFILES;
    let lastError: unknown = null;

    for (const profile of profiles) {
      const attemptStart = Date.now();
      try {
        const browser = await browserType.launch({
          ...(engineName === 'chromium' && provisioned.executablePath ? { executablePath: provisioned.executablePath } : {}),
          headless: config.browser.headless,
          timeout: config.browser.launchTimeoutMs,
          slowMo: config.browser.slowMoMs,
          args: [...profile.args, ...(provisioned.args ?? []), ...(config.browser.args ?? [])],
          env: { ...process.env, ...(provisioned.env ?? {}), ...browserEnv(config) },
          chromiumSandbox: false,
          downloadsPath: config.browser.downloadDir ? path.join(this.profileDir, 'downloads') : undefined,
          ignoreDefaultArgs: config.browser.ignoreDefaultArgs as string[] | undefined,
        });
        await this.healthCheck(browser);
        this.browser = browser;
        this.launch = {
          profileId: profile.id,
          attempts: [...attempts, { profileId: profile.id, ok: true, durationMs: Date.now() - attemptStart }],
          browser: provisioned,
          durationMs: Date.now() - started,
          version: browser.version(),
        };
        browser.on('disconnected', () => {
          if (!this.crashed) {
            this.crashed = true;
            this.crashReason = 'Browser process disconnected.';
            this.events.onCrash?.(this.crashReason);
          }
        });
        log.info('browser launched', { profile: profile.id, ms: this.launch.durationMs, version: this.launch.version });
        return;
      } catch (err) {
        lastError = err;
        attempts.push({ profileId: profile.id, ok: false, error: firstLine(err), durationMs: Date.now() - attemptStart });
        log.debug('launch attempt failed', { profile: profile.id, error: firstLine(err) });
        // A failed probe must not leave an orphaned browser process behind.
        const partial = (lastError as { __browser?: Browser }).__browser;
        if (partial) await partial.close().catch(() => {});
      }
    }

    throw new LensError({
      code: LensErrorCode.BROWSER_LAUNCH_FAILED,
      message: `Lens could not start ${engineName}.`,
      scope: 'environment',
      detail: [
        `Executable: ${provisioned.executablePath}`,
        `Source: ${provisioned.label}`,
        ...attempts.map((a) => (a.ok ? `  ✓ ${a.profileId} (${humanDuration(a.durationMs)})` : `  ✗ ${a.profileId}: ${a.error}`)),
      ].join('\n'),
      hints: [
        'Install a Playwright-managed browser: `npx playwright install --with-deps chromium`.',
        'In air-gapped containers: `npm install -D @sparticuz/chromium` and retry.',
        'Set browser.executablePath (or LENS_BROWSER_EXECUTABLE) to a browser that already works.',
        'Run `lens doctor --fix` for a step-by-step diagnosis.',
      ],
      cause: lastError,
      data: { executablePath: provisioned.executablePath, attempts },
    });
  }

  private async healthCheck(browser: Browser): Promise<void> {
    const timeout = this.config.browser.healthTimeoutMs ?? 20_000;
    let context: BrowserContext;
    try {
      context = await withTimeout(browser.newContext(), timeout, 'The browser did not answer within the launch health-check window.');
    } catch (err) {
      (err as { __browser?: Browser }).__browser = browser;
      throw err;
    }
    const page = context;
    try {
      const probe = await page.newPage();
      await withTimeout(probe.goto('about:blank'), 10_000, 'about:blank did not load.');
      const value = await withTimeout(probe.evaluate(() => 1 + 1), 10_000, 'Renderer eval timed out.');
      if (value !== 2) throw new Error('Renderer returned an unexpected value.');
      await probe.close().catch(() => {});
      await context.close().catch(() => {});
    } catch (err) {
      await page.close().catch(() => {});
      const wrapped = err as { __browser?: Browser };
      wrapped.__browser = browser;
      throw wrapped;
    }
  }

  // ---------------------------------------------------------------- context

  /** Lazily create the persistent isolated context Lens shares across pages. */
  async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.assertAlive();
    const config = this.config;
    const engineName = config.browser.engine;

    const options: Parameters<Browser['newContext']>[0] = {
      viewport: { width: this.viewport.width, height: this.viewport.height },
      deviceScaleFactor: this.viewport.deviceScaleFactor,
      colorScheme: config.browser.colorScheme,
      locale: config.browser.locale,
      timezoneId: config.browser.timezoneId,
      reducedMotion: config.browser.reducedMotion,
      ignoreHTTPSErrors: config.browser.ignoreHttpsErrors,
      acceptDownloads: config.browser.downloadDir !== false,
    };

    // Device presets only make sense for Chromium, where Lens owns the context.
    if (config.browser.device && engineName === 'chromium') {
      const preset = (devices as Record<string, { viewport?: { width: number; height: number }; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean; userAgent?: string }>)[
        config.browser.device
      ];
      if (!preset) {
        throw new LensError({
          code: LensErrorCode.INVALID_INPUT,
          message: `Unknown device "${config.browser.device}".`,
          scope: 'input',
          hints: ['Use a Playwright device name such as "iPhone 13", "Pixel 7" or "Desktop Safari" (see `lens devices`).'],
        });
      }
      Object.assign(options, {
        viewport: preset.viewport ?? options.viewport,
        deviceScaleFactor: preset.deviceScaleFactor ?? options.deviceScaleFactor,
        isMobile: preset.isMobile,
        hasTouch: preset.hasTouch,
        userAgent: preset.userAgent,
      });
    }

    if (config.security.storageState) {
      const storagePath = path.resolve(config.root, config.security.storageState);
      if (!fs.existsSync(storagePath)) {
        throw new LensError({
          code: LensErrorCode.FILE_NOT_FOUND,
          message: `security.storageState points at ${config.security.storageState}, which does not exist.`,
          scope: 'input',
          hints: ['Create it with `lens auth save --from-session <id>` or clear the setting.'],
        });
      }
      options.storageState = storagePath;
      this.storageStatePath = storagePath;
    }

    if (config.recording.mode === 'context-video') {
      // Playwright only records video if its own ffmpeg helper exists; provisioning
      // it here turns a confusing `newContext` throw into a working recording.
      const ffmpeg = provisionPlaywrightFfmpeg();
      if (!ffmpeg) {
        throw new LensError({
          code: LensErrorCode.RECORDING_FAILED,
          message: 'recording.mode = "context-video" needs Playwright’s ffmpeg helper, which is not installed.',
          scope: 'environment',
          hints: [
            'Install it with `npx playwright install ffmpeg`, or',
            'use the default backend instead: recording.mode = "auto" (CDP screencast + any ffmpeg, with frame-sequence fallback).',
          ],
        });
      }
      options.recordVideo = {
        dir: path.join(config.artifactPath, config.recording.dir, '.session-video'),
        size: config.recording.size ?? { width: config.viewport.width, height: config.viewport.height },
      };
    }

    const browser = this.browser;
    if (!browser) throw this.notStartedError();
    const context = await browser.newContext(options);
    context.setDefaultTimeout(config.defaults.actionTimeoutMs);
    context.setDefaultNavigationTimeout(config.defaults.navigationTimeoutMs);

    // Bundlers (esbuild, and therefore Lens's own vitest/tsx runs) rewrite named
    // inner functions into a `__name(fn, label)` helper that only exists in the
    // Node realm. Lens stringifies page-side functions into the browser, so the
    // helper is defined here as a faithful no-op; without it an evaluated probe
    // throws `__name is not defined` in a bundled build.
    await context
      .addInitScript({
        content: 'globalThis.__name = globalThis.__name || function (fn, name) { try { Object.defineProperty(fn, "name", { value: name, configurable: true }); } catch (e) {} return fn; };',
      })
      .catch(() => {});

    context.on('page', (page) => {
      // Popups and target=_blank tabs join the registry so agents can see them.
      this.registerPage(page, 'popup');
    });

    this.context = context;
    return context;
  }

  // ------------------------------------------------------------------- pages

  private registerPage(page: Page, origin: ManagedPage['origin']): ManagedPage {
    this.pageSeq += 1;
    const managed: ManagedPage = { id: `p${this.pageSeq}`, page, createdAt: new Date().toISOString(), origin };
    this.pages.set(managed.id, managed);
    this.activePageIdValue = managed.id;
    page.on('close', () => {
      this.pages.delete(managed.id);
      if (this.activePageIdValue === managed.id) this.activePageIdValue = this.pages.keys().next().value ?? null;
      this.events.onClose?.(managed.id);
    });
    page.on('crash', () => {
      managed.crashed = true;
      managed.crashReason = `Renderer for page ${managed.id} crashed while rendering ${managed.page.url() || 'about:blank'}.`;
      this.events.onCrash?.(managed.crashReason);
    });
    page.on('download', (download) => {
      this.downloads.push({
        pageId: managed.id,
        suggested: download.suggestedFilename(),
        path: download.suggestedFilename() ? path.join(this.profileDir, 'downloads', download.suggestedFilename()) : null,
        at: new Date().toISOString(),
      });
      this.events.onDownload?.(managed.id, download);
    });
    page.on('dialog', (dialog) => {
      const isUnload = dialog.type() === 'beforeunload';
      const accept = isUnload || this.config.browser.dialogPolicy === 'accept';
      this.events.onDialog?.(managed.id, { type: dialog.type(), message: dialog.message(), accepted: accept });
      if (this.config.browser.dialogPolicy === 'manual') return;
      void (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
    this.events.onPage?.(managed);
    return managed;
  }

  /** Open a URL in a new tab (or reuse the only blank tab). */
  async open(url: string, options: { reuse?: boolean } = {}): Promise<ManagedPage> {
    assertNavigationAllowed(this.config, url);
    const context = await this.ensureContext();
    let managed: ManagedPage | null = null;

    if (options.reuse !== false) {
      for (const candidate of this.pages.values()) {
        const current = candidate.page.url();
        if (current === '' || current === 'about:blank') {
          managed = candidate;
          break;
        }
      }
    }

    if (!managed) managed = this.registerPage(await context.newPage(), 'lens');
    await this.navigate(managed, url);
    return managed;
  }

  async navigate(managed: ManagedPage, url: string): Promise<void> {
    assertNavigationAllowed(this.config, url);
    const config = this.config;
    const waitFor = config.defaults.waitFor === 'none' ? 'commit' : config.defaults.waitFor;

    const response = await managed.page.goto(url, { waitUntil: waitFor as 'load', timeout: config.defaults.navigationTimeoutMs }).catch(async (err: Error) => {
      throw await this.classifyNavigationError(url, err);
    });

    if (response && response.status() >= 400) {
      log.debug('navigation returned an http error', { url, status: response.status() });
    }
    await this.settle(managed.page);
  }

  private async classifyNavigationError(url: string, err: Error): Promise<LensError> {
    const message = err.message;
    const target = safeParseUrl(url);
    const refused = /ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|net::ERR_NAME/i.test(message);
    const timeout = /Timeout \d+ms exceeded|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|waitForURL/i.test(message);
    const cert = /ERR_CERT|ERR_SSL/i.test(message);
    const http = target ? await probeUrl(url, 1200) : null;

    const isLocal = target ? ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname) : false;
    const base = isLocal
      ? `Lens could not reach ${target?.host ?? url}.`
      : `Navigation failed for ${url}.`;

    if (cert) {
      return new LensError({
        code: LensErrorCode.NAVIGATE_FAILED,
        message: `${base} The TLS certificate was rejected.`,
        scope: 'application',
        detail: message.split('\n')[0],
        hints: ['For a local self-signed cert, set browser.ignoreHttpsErrors: true in lens.config.json.'],
        cause: err,
      });
    }

    if (isLocal && (refused || timeout) && http && !http.ok) {
      return new LensError({
        code: LensErrorCode.DEV_SERVER_UNAVAILABLE,
        message: `${base} Nothing is listening on ${target?.host}.`,
        scope: 'environment',
        detail: `Probe result: ${http.error ?? 'no response'}`,
        hints: this.projectHints(target?.port ? Number(target.port) : null),
        cause: err,
        data: { url, port: target?.port ? Number(target.port) : null },
        retryable: true,
      });
    }

    if (timeout) {
      return new LensError({
        code: LensErrorCode.NAVIGATE_TIMEOUT,
        message: `${base} The page did not settle within ${humanDuration(this.config.defaults.navigationTimeoutMs)}.`,
        scope: 'application',
        detail: message.split('\n')[0],
        hints: [
          'The app may be waiting on a long-lived connection (websockets, SSE, hot-reload pings).',
          'Retry with --wait-for domcontentloaded, or raise defaults.navigationTimeoutMs.',
        ],
        cause: err,
        retryable: true,
      });
    }

    return new LensError({
      code: LensErrorCode.NAVIGATE_FAILED,
      message: base,
      scope: 'application',
      detail: message.split('\n')[0],
      hints: ['Check the dev server logs, then re-run `lens open` with the exact URL.'],
      cause: err,
    });
  }

  private projectHints(port: number | null): string[] {
    const profile: ProjectProfile | null = this.projectProfile ?? null;
    const hints = devServerHints(profile, port);
    if (this.config.devServer?.command) hints.unshift(`Start it with: ${this.config.devServer.command}`);
    hints.push('`lens doctor` explains what Lens looked for.');
    return hints;
  }

  /** Optional detection context used to make dev-server failures actionable. */
  projectProfile: ProjectProfile | null = null;

  private async settle(page: Page): Promise<void> {
    const settleMs = this.config.defaults.settleMs;
    if (settleMs > 0) await page.waitForTimeout(settleMs).catch(() => {});
    await page
      .waitForFunction(
        () => document.readyState === 'complete' && !(document.fonts && document.fonts.status !== 'loaded'),
        undefined,
        { timeout: Math.min(2500, this.config.defaults.actionTimeoutMs) },
      )
      .catch(() => {});
  }

  // --------------------------------------------------------------- accessors

  get activePage(): ManagedPage | null {
    if (!this.activePageIdValue) return null;
    return this.pages.get(this.activePageIdValue) ?? null;
  }

  get pageCount(): number {
    return this.pages.size;
  }

  get activePageId(): string | null {
    return this.activePageIdValue;
  }

  requireActivePage(): ManagedPage {
    const page = this.activePage;
    if (page?.crashed) {
      throw new LensError({
        code: LensErrorCode.BROWSER_CRASHED,
        message: page.crashReason ?? 'The page renderer crashed.',
        scope: 'browser',
        hints: ['Re-open the page: `lens open <url> --reuse`. If it repeats, capture `lens report` and check memory.'],
        retryable: true,
        data: { pageId: page.id },
      });
    }
    if (!page) {
      throw new LensError({
        code: LensErrorCode.NO_ACTIVE_PAGE,
        message: 'No page is open in this Lens session.',
        scope: 'input',
        hints: ['Open one first: `lens open http://localhost:5173`.'],
      });
    }
    return page;
  }

  page(id?: string): ManagedPage {
    if (!id) return this.requireActivePage();
    const byId = this.pages.get(id);
    if (byId?.crashed) {
      throw new LensError({
        code: LensErrorCode.BROWSER_CRASHED,
        message: byId.crashReason ?? `Page ${id} crashed.`,
        scope: 'browser',
        retryable: true,
      });
    }
    const found = this.pages.get(id) ?? [...this.pages.values()].find((p) => p.id === id || p.page.url() === id);
    if (!found) {
      throw new LensError({
        code: LensErrorCode.PAGE_NOT_FOUND,
        message: `No page "${id}" in this session.`,
        scope: 'input',
        detail: this.pages.size ? `Known: ${[...this.pages.keys()].join(', ')}` : 'The session has no open pages.',
        hints: ['Use `lens tabs` to list pages, or `lens open <url>` to add one.'],
        data: { known: [...this.pages.keys()] },
      });
    }
    return found;
  }

  listPages(): Array<{ id: string; url: string; title: string; active: boolean; origin: ManagedPage['origin']; createdAt: string }> {
    return [...this.pages.values()].map((managed) => ({
      id: managed.id,
      url: managed.page.url(),
      title: '',
      active: managed.id === this.activePageId,
      origin: managed.origin,
      createdAt: managed.createdAt,
    }));
  }

  setActive(id: string): ManagedPage {
    const managed = this.page(id);
    this.activePageIdValue = managed.id;
    return managed;
  }

  async closePage(id: string): Promise<boolean> {
    const managed = this.pages.get(id);
    if (!managed) return false;
    await managed.page.close({ runBeforeUnload: false }).catch(() => {});
    this.pages.delete(id);
    if (this.activePageIdValue === id) this.activePageIdValue = this.pages.keys().next().value ?? null;
    return true;
  }

  async closeOtherPages(): Promise<number> {
    const active = this.activePageIdValue;
    const ids = [...this.pages.keys()].filter((id) => id !== active);
    for (const id of ids) await this.closePage(id);
    return ids.length;
  }

  // ------------------------------------------------------------- environment

  /**
   * Resize the active page. Width/height go through Playwright; device scale goes
   * through CDP `Emulation.setDeviceMetricsOverride`, which — unlike context
   * creation options — can change while the session is live. That is what makes
   * `lens responsive` able to render a real 3x mobile viewport without relaunching.
   */
  async setViewport(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<void> {
    this.viewport = { ...this.viewport, ...viewport };
    await this.ensureContext();
    const page = this.activePage;
    if (!page) return;
    await page.page.setViewportSize({ width: viewport.width, height: viewport.height });
    const dsf = viewport.deviceScaleFactor ?? 1;
    try {
      const cdp = await page.page.context().newCDPSession(page.page);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: dsf,
        mobile: dsf > 1 && viewport.width < 900,
      });
      this.cdpSessions.set(page.id, cdp);
    } catch (err) {
      log.debug('device metrics override unavailable; falling back to CSS viewport', { error: (err as Error).message });
      await page.page
        .evaluate((ratio) => {
          Object.defineProperty(window, 'devicePixelRatio', { value: ratio, configurable: true });
        }, dsf)
        .catch(() => {});
    }
  }

  /** Clear device-metric emulation (used when leaving responsive mode). */
  async clearDeviceMetrics(pageId?: string): Promise<void> {
    const id = pageId ?? this.activePageIdValue;
    if (!id) return;
    const session = this.cdpSessions.get(id);
    if (!session) return;
    await session.send('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
    this.cdpSessions.delete(id);
  }

  get currentViewport(): { width: number; height: number; deviceScaleFactor: number } {
    return { ...this.viewport };
  }

  get downloadsList(): ReadonlyArray<{ pageId: string; suggested: string; path: string | null; at: string }> {
    return this.downloads;
  }

  status(): RuntimeStatus {
    const launch = this.launch;
    return {
      running: this.browser !== null && !this.crashed,
      engine: this.config.browser.engine,
      headless: this.config.browser.headless,
      launchProfile: launch?.profileId ?? 'n/a',
      browserLabel: launch?.browser.label ?? 'not launched',
      executablePath: launch?.browser.executablePath ?? 'n/a',
      version: launch?.version ?? 'n/a',
      profileDir: this.profileDir,
      pid: this.browserProcessId(),
      startedAt: this.startedAt,
      uptimeMs: Date.now() - new Date(this.startedAt).getTime(),
      pages: this.pages.size,
      crashed: this.crashed,
      viewport: this.currentViewport,
      storageStatePath: this.storageStatePath,
    };
  }

  private browserProcessId(): number | null {
    try {
      const browser = this.browser as unknown as { process?: () => import('node:child_process').ChildProcess | null };
      return browser?.process?.()?.pid ?? null;
    } catch {
      return null;
    }
  }

  private assertAlive(): void {
    if (this.crashed || !this.browser) {
      throw new LensError({
        code: this.crashed ? LensErrorCode.BROWSER_CRASHED : LensErrorCode.SESSION_NOT_STARTED,
        message: this.crashed ? 'The Lens browser process stopped responding.' : 'Lens has not started a browser session.',
        scope: 'browser',
        detail: this.crashReason ?? undefined,
        hints: this.crashed
          ? ['Re-open the session: `lens close --all` then `lens open <url>`.', 'If the browser keeps crashing, run `lens doctor` and check memory available to the container.']
          : ['`lens open <url>` starts a session automatically.'],
        retryable: this.crashed,
      });
    }
  }

  private notStartedError(): LensError {
    return new LensError({
      code: LensErrorCode.SESSION_NOT_STARTED,
      message: 'Lens has no live browser.',
      scope: 'browser',
      hints: ['Start one with `lens open <url>`, or `lens session start` for a blank page.'],
    });
  }

  /** Export cookies + storage so a later session can reuse an authenticated local app. */
  async saveStorageState(target: string): Promise<string> {
    const context = await this.ensureContext();
    await context.storageState({ path: target });
    return target;
  }

  async close(options: { deleteProfile?: boolean } = {}): Promise<void> {
    for (const managed of [...this.pages.values()]) {
      await managed.page.close({ runBeforeUnload: false }).catch(() => {});
    }
    this.pages.clear();
    this.activePageIdValue = null;
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    const deleteProfile = options.deleteProfile ?? this.config.browser.profileMode === 'ephemeral';
    if (deleteProfile) await removeTree(this.profileDir).catch(() => {});
  }
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Browser-process environment contributed by configuration. */
function browserEnv(config: ResolvedConfig): Record<string, string> {
  const env: Record<string, string> = { ...config.browser.env };
  if (config.browser.fontConfig) {
    const resolved = path.resolve(config.root, config.browser.fontConfig);
    if (!fs.existsSync(resolved)) {
      throw new LensError({
        code: LensErrorCode.FILE_NOT_FOUND,
        message: `browser.fontConfig points at ${config.browser.fontConfig}, which does not exist.`,
        scope: 'input',
        hints: ['Unset it to let fontconfig use the system configuration (the default and the safe choice).'],
        data: { resolved },
      });
    }
    env.FONTCONFIG_FILE = resolved;
  }
  return env;
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0]?.slice(0, 300) ?? 'unknown error';
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
