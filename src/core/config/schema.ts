/**
 * Lens configuration schema.
 *
 * The config object is the single source of truth for behaviour: browser
 * launch, viewport, security posture, capture defaults, review thresholds and
 * recording. It is resolved once (CLI/MCP entry) and then passed explicitly to
 * everything that needs it — no ambient globals.
 */
import { z } from 'zod';

export const viewportProfileSchema = z.object({
  label: z.string().optional(),
  width: z.number().int().positive().max(7680),
  height: z.number().int().positive().max(4320),
  deviceScaleFactor: z.number().positive().max(4).default(1),
  mobile: z.boolean().optional(),
  hasTouch: z.boolean().optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
});

export const DEFAULT_VIEWPORT_PROFILES: Record<string, z.infer<typeof viewportProfileSchema>> = {
  desktop: { label: 'Desktop', width: 1440, height: 900, deviceScaleFactor: 1 },
  laptop: { label: 'Laptop', width: 1280, height: 800, deviceScaleFactor: 1 },
  tablet: { label: 'Tablet', width: 1024, height: 768, deviceScaleFactor: 2 },
  mobile: { label: 'Mobile', width: 390, height: 844, deviceScaleFactor: 3, mobile: true, hasTouch: true, orientation: 'portrait' },
  'small-mobile': { label: 'Small mobile', width: 360, height: 800, deviceScaleFactor: 3, mobile: true, hasTouch: true, orientation: 'portrait' },
};

export const DEFAULT_RESPONSIVE_ORDER = ['desktop', 'laptop', 'tablet', 'mobile', 'small-mobile'];

const positiveInt = (max?: number) => z.number().int().positive().max(max ?? 10_000_000);

export const lensConfigSchema = z
  .object({
    /** Directory (relative to root) where all Lens evidence lives. */
    artifactDir: z.string().min(1).default('.lens'),
    /** Base URL used when a command receives only a port or a path. */
    baseUrl: z.string().optional(),
    root: z.string().optional(),

    browser: z
      .object({
        /** 'chromium' is implemented; firefox/webkit are architecture-ready. */
        engine: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
        /** Playwright channel, e.g. 'chrome', 'msedge'. Ignored for custom executables. */
        channel: z.string().optional(),
        /** Absolute path to a browser executable. Wins over channel/playwright-managed. */
        executablePath: z.string().optional(),
        headless: z.boolean().default(true),
        args: z.array(z.string()).default([]),
        /**
         * Explicit FONTCONFIG_FILE for the browser process. Off by default: the
         * serverless Chromium distributions ship a fontconfig file that Skia cannot
         * use and that aborts the browser process. Set it only with a config you own.
         */
        fontConfig: z.string().optional(),
        /** Extra environment variables for the browser process. */
        env: z.record(z.string()).default({}),
        ignoreDefaultArgs: z.array(z.string()).optional(),
        slowMoMs: z.number().nonnegative().default(0),
        launchTimeoutMs: positiveInt(120_000).default(60_000),
        locale: z.string().default('en-US'),
        timezoneId: z.string().optional(),
        colorScheme: z.enum(['light', 'dark', 'no-preference']).default('light'),
        reducedMotion: z.enum(['no-preference', 'reduce']).default('no-preference'),
        device: z.string().optional(),
        ignoreHttpsErrors: z.boolean().default(false),
        downloadDir: z.boolean().default(true),
        /**
         * JS dialog handling. `beforeunload` is always accepted so navigation is not
         * blocked. `dismiss` is the safe default: an agent's accidental click must not
         * confirm a destructive dialog.
         */
        dialogPolicy: z.enum(['dismiss', 'accept', 'manual']).default('dismiss'),
        /** Kill the browser if it stays unresponsive this long during a launch probe. */
        healthTimeoutMs: positiveInt(120_000).default(20_000),
        /** Try progressively safer flag sets when the first launch fails. */
        launchFallbacks: z.boolean().default(true),
        /** Isolated profile dir policy: 'ephemeral' deletes on close, 'persist' keeps per-session. */
        profileMode: z.enum(['ephemeral', 'persist']).default('persist'),
      })
      .default({}),

    viewport: viewportProfileSchema
      .omit({ label: true, orientation: true })
      .default({ width: 1440, height: 900, deviceScaleFactor: 1 }),

    profiles: z.record(viewportProfileSchema).default(DEFAULT_VIEWPORT_PROFILES),

    defaults: z
      .object({
        navigationTimeoutMs: positiveInt(300_000).default(30_000),
        actionTimeoutMs: positiveInt(300_000).default(10_000),
        settleMs: z.number().nonnegative().default(250),
        waitFor: z.enum(['load', 'domcontentloaded', 'networkidle', 'none']).default('load'),
      })
      .default({}),

    security: z
      .object({
        /** Allow navigating to origins that are not local and not allowlisted. */
        allowExternal: z.boolean().default(false),
        /** Glob/list of origins explicitly trusted (e.g. `https://staging.example.com`). */
        allowedOrigins: z.array(z.string()).default([]),
        blockedOrigins: z.array(z.string()).default([]),
        /** Treat these additional hostnames as local (e.g. `*.test`, `my-app.localhost`). */
        localHostnames: z.array(z.string()).default([]),
        /** Attach an existing storage state file. Never auto-detected from the user's browser. */
        storageState: z.string().optional(),
        persistStorage: z.boolean().default(true),
        /** Redact obvious secrets from snapshots, reports, screenshots metadata and logs. */
        redactSensitive: z.boolean().default(true),
        extraRedactPatterns: z.array(z.string()).default([]),
        /** Refuse to record while a password/secret field has focus or holds text. */
        recordingGuards: z.boolean().default(true),
        /** Block `file://` navigation unless explicitly enabled. */
        allowFileUrls: z.boolean().default(false),
        /** Extra directories `lens upload` may read, beyond the project root. */
        uploadDirs: z.array(z.string()).default([]),
      })
      .default({}),

    capture: z
      .object({
        format: z.enum(['png', 'jpeg', 'webp']).default('png'),
        quality: z.number().int().min(1).max(100).optional(),
        fullPage: z.boolean().default(false),
        omitBackground: z.boolean().default(false),
        /** Screenshot scale: 'css' keeps text crisp at DPR, 'device' renders at native pixels. */
        scale: z.enum(['css', 'device']).default('device'),
        timeoutMs: positiveInt(120_000).default(20_000),
        /** Multiply the page's device scale factor for hi-res exports. */
        maxDeviceScaleFactor: z.number().positive().max(6).default(3),
        /** Write `<name>.png.json` beside each capture with size/hash/scope. */
        writeSidecar: z.boolean().default(true),
      })
      .default({}),

    console: z
      .object({
        enabled: z.boolean().default(true),
        levels: z.array(z.enum(['log', 'info', 'warn', 'warning', 'error', 'debug', 'trace'])).default(['error', 'warning']),
        captureAll: z.boolean().default(true),
        maxEntries: positiveInt(20_000).default(500),
        captureStack: z.boolean().default(true),
      })
      .default({}),

    network: z
      .object({
        enabled: z.boolean().default(true),
        maxEntries: positiveInt(50_000).default(1000),
        captureBodies: z.boolean().default(false),
        maxBodyBytes: positiveInt(4_000_000).default(65_536),
        /** Requests matching these patterns are excluded from failure accounting. */
        ignorePatterns: z
          .array(z.string())
          .default([
            '*.hot-update.*',
            '/__vite_ping',
            '/sockjs-node/*',
            'ws://*',
            'wss://*',
            '*/favicon.ico',
            '/*.@(png|jpg|jpeg|svg|webp|avif|ico|woff|woff2|ttf|css|js)',
          ]),
        /** Track requests that never finish within this budget as slow. */
        slowMs: positiveInt(600_000).default(5_000),
        trackWebsockets: z.boolean().default(false),
      })
      .default({}),

    review: z
      .object({
        /** Every check can be disabled here or per-run with `--skip`. */
        checks: z
          .array(
            z.enum([
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
            ]),
          )
          .default([
            'layout-overflow',
            'clipped-text',
            'contrast',
            'broken-images',
            'empty-state',
            'tap-targets',
            'overlap',
            'unstyled',
            'focus-visible',
            'console',
            'network',
          ]),
        thresholds: z
          .object({
            minContrast: z.number().min(1).max(21).default(4.5),
            minContrastLargeText: z.number().min(1).max(21).default(3),
            minTapTargetPx: z.number().positive().default(40),
            overflowTolerancePx: z.number().nonnegative().default(2),
            /** Ratio of a viewport that may be blank before `empty-state` fires. */
            emptyAreaRatio: z.number().min(0).max(1).default(0.55),
            /** Font-size/leading ratio under which text is judged too dense. */
            minLineHeightRatio: z.number().min(0.5).max(2).default(1.05),
            overlapSeverityAreaPx: positiveInt(1_000_000).default(1600),
          })
          .default({}),
        maxIssuesPerCheck: positiveInt(500).default(40),
        /** Treat these CSS selectors as intentional decoration when scanning layout. */
        ignoreSelectors: z.array(z.string()).default(['[data-lens-ignore]', '[aria-hidden="true"]', 'canvas', 'video']),
      })
      .default({}),

    responsive: z
      .object({
        profiles: z.array(z.string()).default(DEFAULT_RESPONSIVE_ORDER),
        capture: z.enum(['none', 'screenshot']).default('screenshot'),
        /** Reload for each profile (true) or just resize (false). Reload is more faithful. */
        reload: z.boolean().default(false),
        setDeviceMetrics: z.boolean().default(true),
        /** Write a paired md/json report for every responsive run. */
        writeReport: z.boolean().default(true),
      })
      .default({}),

    recording: z
      .object({
        /** 'auto' prefers Playwright context video, falls back to CDP screencast. */
        mode: z.enum(['auto', 'context-video', 'screencast', 'off']).default('auto'),
        dir: z.string().default('recordings'),
        format: z.enum(['webm', 'mp4', 'both']).default('webm'),
        /** 'auto' converts when a usable ffmpeg is discoverable. */
        convert: z.enum(['auto', 'never', 'always']).default('auto'),
        ffmpegPath: z.string().optional(),
        size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
        fps: z.number().int().positive().max(60).default(12),
        bitRateKbps: z.number().int().positive().default(3_000),
        maxDurationMs: positiveInt(30 * 60_000).default(6 * 60_000),
        /** Keep the intermediate JPEG frames next to the video (larger, useful for debugging and for frame-level review). */
        keepFrames: z.boolean().default(false),
        trace: z
          .object({
            enabled: z.boolean().default(true),
            screenshots: z.boolean().default(true),
            snapshots: z.boolean().default(true),
            sources: z.boolean().default(false),
          })
          .default({}),
        overlay: z
          .object({
            enabled: z.boolean().default(true),
            chapters: z.boolean().default(true),
            callouts: z.boolean().default(true),
            cursor: z.boolean().default(true),
            watermark: z.boolean().default(false),
            /** Where the overlay sits. Bottom keeps product UI readable. */
            position: z.enum(['top', 'bottom']).default('bottom'),
            accent: z.string().default('#38bdf8'),
            background: z.string().default('#0b1220'),
            foreground: z.string().default('#ffffff'),
            fontSizePx: z.number().int().positive().max(72).default(22),
            dwellMs: z.number().int().nonnegative().default(1800),
          })
          .default({}),
      })
      .default({}),

    flows: z
      .object({
        /** Directory searched for `*.flow.json` files. */
        dir: z.string().default('.lens/flows'),
        /** Flows declared inline in configuration, keyed by name. */
        inline: z.record(z.unknown()).default({}),
        /** Screenshot every step, not just failures. */
        captureEveryStep: z.boolean().default(false),
        failFast: z.boolean().default(true),
        /** Default per-step timeout; falls back to the action timeout. */
        stepTimeoutMs: z.number().int().positive().optional(),
        /** Keep going after a failed step so one report lists every break. */
        collectAll: z.boolean().default(false),
        /** Write a paired md/json report for every flow run. */
        writeReport: z.boolean().default(true),
      })
      .default({}),

    showcase: z
      .object({
        /** Refuse to record until a purpose/audience/features brief exists. */
        requireBrief: z.boolean().default(true),
        askMissing: z.array(z.string()).default(['purpose', 'audience', 'features']),
        stepDwellMs: z.number().int().nonnegative().default(1200),
        readMs: z
          .object({ per100Chars: z.number().nonnegative().default(700), min: z.number().nonnegative().default(1200), max: z.number().nonnegative().default(5200) })
          .default({}),
        endOnStrongestScreen: z.boolean().default(true),
        selfReview: z.boolean().default(true),
        /** Re-record automatically when self-review reports failures. */
        autoRevise: z.boolean().default(false),
        maxAttempts: positiveInt(4).default(2),
        useDemoData: z.boolean().default(true),
        /** Prefix on every value typed during a demonstration, so demo data is unmistakable. */
        demoMarker: z.string().default('Demo'),
      })
      .default({}),

    preview: z
      .object({
        dir: z.string().default('previews'),
        /** Default OG/social canvas. */
        size: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).default({ width: 1200, height: 630 }),
        formats: z.array(z.enum(['png', 'jpeg', 'webp'])).default(['png']),
        deviceScaleFactor: z.number().positive().max(4).default(2),
        brand: z
          .object({
            name: z.string().optional(),
            tagline: z.string().optional(),
            accent: z.string().default('#38bdf8'),
            background: z.string().default('#0b1120'),
            foreground: z.string().default('#f8fafc'),
            muted: z.string().default('#94a3b8'),
            logo: z.string().optional(),
            url: z.string().optional(),
            /** Visual style for the generated canvas. */
            style: z.enum(['device', 'flat', 'gradient', 'minimal']).default('device'),
          })
          .default({}),
        /** Copy the generated image into the project's static dir and wire meta tags. */
        publish: z.boolean().default(false),
        /** Overall canvas treatment for the composed plate. */
        theme: z.enum(['dark', 'light', 'brand']).default('dark'),
        /** Render a second @2x export beside the primary image. */
        retina: z.boolean().default(false),
        /** Scale used when capturing the source screenshot (keeps text crisp). */
        captureScale: z.number().positive().max(4).default(2),
        /** Capture the whole scrollable page instead of the viewport. */
        captureFullPage: z.boolean().default(false),
        /** Emit the og/twitter tag block beside every preview. */
        writeMetadata: z.boolean().default(true),
        /** After generating, also verify what the live URL actually serves. */
        verifyLive: z.boolean().default(false),
        /** Publisher handle for twitter:site, without the @. */
        twitter: z.string().optional(),
      })
      .default({}),

    devServer: z
      .object({
        url: z.string().optional(),
        port: z.number().int().positive().optional(),
        command: z.string().optional(),
        waitTimeoutMs: positiveInt(300_000).default(120_000),
        /** Candidate ports probed during failure diagnosis. */
        candidatePorts: z.array(z.number().int().positive()).default([5173, 3000, 4321, 8080, 5174, 4173, 3001, 1234, 8000, 9000]),
      })
      .default({}),

    daemon: z
      .object({
        autoStart: z.boolean().default(true),
        idleTimeoutMs: positiveInt(24 * 3_600_000).default(45 * 60_000),
        startTimeoutMs: positiveInt(120_000).default(25_000),
        requestTimeoutMs: positiveInt(600_000).default(180_000),
      })
      .default({}),

    mcp: z
      .object({
        serverName: z.string().default('lens'),
        /** Include base64 screenshots in tool results (costly; off by default). */
        inlineImages: z.boolean().default(false),
        /** Emit an instruction blob describing the recommended verify loop. */
        instructions: z.boolean().default(true),
      })
      .default({}),
  })
  .passthrough();

export type ViewportProfile = z.infer<typeof viewportProfileSchema>;
export type LensConfig = z.infer<typeof lensConfigSchema>;
export type LensConfigInput = z.input<typeof lensConfigSchema>;
