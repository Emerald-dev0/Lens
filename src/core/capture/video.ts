/**
 * Session recording.
 *
 * Lens records a demonstration, not just pixels on a clock. Two backends exist
 * because they answer different needs:
 *
 *  • `screencast` (default) — CDP `Page.startScreencast`, assembled with ffmpeg.
 *    Start/stop mid-session, chapter markers, action callouts and the synthetic
 *    cursor are all real DOM, so they appear in the recording. Falls back to a
 *    numbered frame sequence + timing manifest when no ffmpeg is available, which
 *    still supports self-review.
 *  • `context-video` — Playwright's own context recorder. Records the whole
 *    session and is exported on `lens close`; it cannot be started and stopped
 *    mid-session, because the video file is finalised when the context closes.
 *
 * A recording that captured nothing is treated as a failure, not a success with a
 * small file: the recorder reports frame coverage and warns when the demo was idle.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CDPSession, Page } from 'playwright-core';

import type { ResolvedConfig } from '../config/load.js';
import type { ArtifactKind } from '../artifacts/paths.js';
import { ensureDir, fileSize, isoNow, safeName, writeJson } from '../util/fs.js';
import { convertVideo, findFfmpeg, provisionPlaywrightFfmpeg, probeVideo } from './ffmpeg.js';
import { LensError, LensErrorCode } from '../errors.js';
import { log } from '../util/log.js';
import type { OverlayLayer } from './overlay.js';
import type { TraceRecorder } from './trace.js';

export type RecordingBackend = 'screencast' | 'context-video';
export type RecordingFormat = 'webm' | 'mp4' | 'both';

export interface RecordingOptions {
  mode?: 'auto' | 'screencast' | 'context-video' | 'off';
  format?: RecordingFormat;
  fps?: number;
  size?: { width: number; height: number };
  bitRateKbps?: number;
  maxDurationMs?: number;
  /** Label for the artifact name, e.g. `harbor-onboarding`. */
  label?: string;
  /** First chapter title. */
  title?: string;
  overlays?: boolean;
  cursor?: boolean;
  /** Quality of the JPEG frames fed to the encoder. */
  frameQuality?: number;
  pageId?: string;
}

export interface ChapterMarker {
  title: string;
  atMs: number;
  note?: string;
  screenshot?: string;
}

export interface RecordedArtifact {
  kind: 'webm' | 'mp4' | 'frames' | 'poster' | 'trace' | 'chapters' | 'manifest';
  path: string;
  bytes: number;
  meta?: Record<string, unknown>;
}

export interface RecordingState {
  active: boolean;
  backend: RecordingBackend | null;
  startedAt: string | null;
  elapsedMs: number;
  frames: number;
  fps: number;
  chapters: ChapterMarker[];
  label: string | null;
  pageId: string | null;
  warnings: string[];
}

export interface StopResult {
  ok: boolean;
  backend: RecordingBackend;
  durationMs: number;
  frames: number;
  fps: number;
  coverageRatio: number;
  webm?: string;
  mp4?: string;
  poster?: string;
  trace?: string;
  chapters: ChapterMarker[];
  artifacts: RecordedArtifact[];
  warnings: string[];
  stats: { consoleErrors: number; networkFailures: number; actions: number };
  video: { width: number | null; height: number | null; durationMs: number | null };
  pending?: boolean;
  manifest?: string;
}

/** What the recorder needs from its host session; keeps the module decoupled. */
export interface RecorderHost {
  config: ResolvedConfig;
  pageFor(pageId?: string | null): { id: string; page: Page };
  overlayFor(pageId?: string | null): Promise<OverlayLayer>;
  allocate(kind: ArtifactKind, base: string, ext: string): Promise<string>;
  relative(absolute: string): string;
  observationCounts(pageId?: string | null, sinceSeq?: number): { consoleErrors: number; networkFailures: number };
  actionCount(): number;
  trace?: TraceRecorder;
}

/**
 * The wire payload Chromium sends for `Page.screencastFrame`. Playwright's protocol
 * typings declare only a subset of the metadata, so the fields Lens relies on
 * (`sessionId`, `offsetWidth`, `offsetHeight`) are typed here at the boundary.
 */
interface ScreencastFramePayload {
  data: string;
  metadata: {
    timestamp?: number;
    sessionId?: number;
    offsetWidth?: number;
    offsetHeight?: number;
    deviceScaleFactor?: number;
    scrollOffsetY?: number;
  };
}

interface FrameRecord {
  file: string;
  atMs: number;
  width: number;
  height: number;
}

export class VideoRecorder {
  private state: {
    active: boolean;
    backend: RecordingBackend | null;
    startedAt: number;
    startedIso: string;
    label: string;
    dir: string;
    frames: FrameRecord[];
    chapters: ChapterMarker[];
    warnings: string[];
    fps: number;
    format: RecordingFormat;
    maxDurationMs: number;
    pageId: string | null;
    overlay: OverlayLayer | null;
    cursorEnabled: boolean;
    frameSeq: number;
    lastFrameAt: number;
    pendingCloseExport: boolean;
    bitRateKbps: number;
  } | null = null;

  private cdp: CDPSession | null = null;
  private screencastListener: ((payload: { data: string; metadata: Record<string, unknown> }) => void) | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private readonly host: RecorderHost;
  private readonly config: ResolvedConfig;
  private sessionVideoPages = new Map<string, { page: Page; label: string }>();

  constructor(host: RecorderHost) {
    this.host = host;
    this.config = host.config;
  }

  get active(): boolean {
    return this.state?.active ?? false;
  }

  resolveBackend(mode: RecordingOptions['mode'] = this.config.recording.mode): RecordingBackend {
    if (mode === 'context-video') return 'context-video';
    if (mode === 'screencast') return 'screencast';
    if (mode === 'off') return 'screencast';
    // auto: CDP screencast gives start/stop control, which is what demos need.
    return 'screencast';
  }

  async start(options: RecordingOptions = {}): Promise<RecordingState> {
    if (this.state?.active) {
      throw new LensError({
        code: LensErrorCode.RECORDING_NOT_ACTIVE,
        message: 'A recording is already running in this session.',
        scope: 'input',
        detail: `Started ${this.state.startedIso} as "${this.state.label}".`,
        hints: ['Stop it first with `lens record stop`, or check state with `lens record status`.'],
      });
    }
    if ((options.mode ?? this.config.recording.mode) === 'off') {
      throw new LensError({
        code: LensErrorCode.ACTION_UNSUPPORTED,
        message: 'Recording is disabled (recording.mode = "off").',
        scope: 'input',
        hints: ['Set recording.mode to "auto" in lens.config.json to enable capture.'],
      });
    }

    const managed = this.host.pageFor(options.pageId);
    const backend = this.resolveBackend(options.mode ?? this.config.recording.mode);
    const label = safeName(options.label ?? `recording-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`, 'recording');
    const dir = await ensureDir(path.join(this.host.config.artifactPath, this.config.recording.dir, label));
    const fps = clampInt(options.fps ?? this.config.recording.fps, 1, 60);
    const startedAt = Date.now();

    this.state = {
      active: true,
      backend,
      startedAt,
      startedIso: isoNow(),
      label,
      dir,
      frames: [],
      chapters: [],
      warnings: [],
      fps,
      format: options.format ?? this.config.recording.format,
      maxDurationMs: options.maxDurationMs ?? this.config.recording.maxDurationMs,
      pageId: managed.id,
      overlay: null,
      cursorEnabled: options.cursor ?? this.config.recording.overlay.cursor,
      frameSeq: 0,
      lastFrameAt: startedAt,
      pendingCloseExport: false,
      bitRateKbps: options.bitRateKbps ?? this.config.recording.bitRateKbps,
    };

    if (options.overlays ?? this.config.recording.overlay.enabled) {
      this.state.overlay = await this.host.overlayFor(managed.id);
    }

    if (backend === 'context-video') {
      const ready = this.playwrightFfmpegReady();
      if (!ready) {
        throw new LensError({
          code: LensErrorCode.RECORDING_FAILED,
          message: 'context-video recording needs Playwright’s ffmpeg helper, which is not installed here.',
          scope: 'environment',
          hints: [
            'Run `npx playwright install ffmpeg`, or',
            'use the default backend instead: `lens record start --mode screencast` (needs any ffmpeg, or falls back to frames).',
          ],
        });
      }
      this.sessionVideoPages.set(managed.id, { page: managed.page, label });
      if (options.title) await this.chapter(options.title, 'opened');
      return this.status();
    }

    const size = options.size ?? this.config.recording.size ?? (await this.viewportSize(managed.page));
    await this.startScreencast(managed.page, size, fps, options.frameQuality ?? 82);

    if (options.title) await this.chapter(options.title, 'started');
    if (this.config.recording.trace.enabled) await this.host.trace?.start(managed.page.context(), { title: label, page: managed.page });

    this.frameTimer = setInterval(() => {
      if (!this.state?.active) return;
      if (Date.now() - this.state.startedAt > this.state.maxDurationMs) {
        log.warn('recording hit its maximum duration; stopping automatically', { label: this.state.label });
        this.state.warnings.push(`Auto-stopped at the configured maximum of ${Math.round(this.state.maxDurationMs / 1000)}s.`);
        void this.stop({ finalize: true });
      }
    }, 1000);
    this.frameTimer.unref?.();

    return this.status();
  }

  private async startScreencast(page: Page, size: { width: number; height: number }, fps: number, quality: number): Promise<void> {
    const state = this.state;
    if (!state) return;
    try {
      const cdp = await page.context().newCDPSession(page);
      this.cdp = cdp;
      await cdp.send('Page.enable').catch(() => {});
      this.screencastListener = (payload) => {
        void this.onFrame(payload as unknown as ScreencastFramePayload);
      };
      cdp.on('Page.screencastFrame', this.screencastListener as never);
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality,
        maxWidth: size.width,
        maxHeight: size.height,
        everyNthFrame: 1,
      });
      log.debug('screencast started', { size, fps });
    } catch (err) {
      state.warnings.push(`CDP screencast could not start (${(err as Error).message.split('\n')[0]}); falling back to timed capture.`);
      this.cdp = null;
      // Poll-based capture keeps the recording usable without CDP.
      const interval = Math.max(40, Math.round(1000 / fps));
      this.frameTimer = setInterval(() => {
        if (!this.state?.active) return;
        void this.capturePollFrame(page);
      }, interval);
      this.frameTimer.unref?.();
    }
  }

  private async capturePollFrame(page: Page): Promise<void> {
    const state = this.state;
    if (!state?.active) return;
    if (Date.now() - state.lastFrameAt < Math.max(40, 1000 / state.fps) - 5) return;
    const file = path.join(state.dir, `frame-${String(++state.frameSeq).padStart(6, '0')}.jpg`);
    const buffer = await page.screenshot({ type: 'jpeg', quality: 80, timeout: 5000 }).catch(() => null);
    if (!buffer) return;
    await fs.promises.writeFile(file, buffer);
    state.lastFrameAt = Date.now();
    state.frames.push({ file, atMs: state.lastFrameAt - state.startedAt, width: 0, height: 0 });
  }

  private async onFrame(payload: ScreencastFramePayload): Promise<void> {
    const state = this.state;
    if (!state?.active || !this.cdp) return;
    const now = Date.now();
    // Chromium can burst frames after a repaint; keep a roughly even sampling.
    const minGap = Math.max(16, 1000 / (state.fps * 2));
    const isKeyframe = state.frames.length === 0;
    if (!isKeyframe && now - state.lastFrameAt < minGap) {
      await this.cdp.send('Page.screencastFrameAck', { sessionId: payload.metadata.sessionId ?? 1 }).catch(() => {});
      return;
    }
    const file = path.join(state.dir, `frame-${String(++state.frameSeq).padStart(6, '0')}.jpg`);
    try {
      await fs.promises.writeFile(file, Buffer.from(payload.data, 'base64'));
      state.frames.push({
        file,
        atMs: now - state.startedAt,
        width: payload.metadata.offsetWidth ?? 0,
        height: payload.metadata.offsetHeight ?? 0,
      });
      state.lastFrameAt = now;
    } catch (err) {
      state.warnings.push(`A frame could not be written (${(err as Error).message.split('\n')[0]}).`);
    }
    await this.cdp.send('Page.screencastFrameAck', { sessionId: payload.metadata.sessionId ?? 1 }).catch(() => {});
  }

  /** Mark a chapter: recorded in the manifest, drawn as a banner, grouped in the trace. */
  async chapter(title: string, note?: string): Promise<ChapterMarker> {
    if (!this.state) {
      throw new LensError({
        code: LensErrorCode.RECORDING_NOT_ACTIVE,
        message: 'Chapters can only be added while a recording is active.',
        scope: 'input',
        hints: ['Start one with `lens record start --title "Introduction"`.'],
      });
    }
    const marker: ChapterMarker = {
      title,
      atMs: Date.now() - this.state.startedAt,
      note,
    };
    this.state.chapters.push(marker);
    const overlay = this.state.overlay;
    const config = this.config.recording.overlay;
    if (overlay && config.enabled && config.chapters) {
      await overlay.banner({
        eyebrow: config.position === 'top' ? undefined : undefined,
        title,
        subtitle: note,
        position: config.position,
        accent: config.accent,
        background: hexToRgba(config.background, 0.92),
        foreground: config.foreground,
        fontSizePx: config.fontSizePx,
      });
      if (config.dwellMs > 0) {
        await delay(Math.min(config.dwellMs, 1400));
      }
    }
    await this.host.trace?.chapter(title);
    return marker;
  }

  /** An on-screen label explaining the interaction that just happened. */
  async callout(text: string, options: { at?: { x: number; y: number }; dwellMs?: number } = {}): Promise<void> {
    const overlay = this.state?.overlay;
    const config = this.config.recording.overlay;
    if (!overlay || !config.enabled || !config.callouts) return;
    await overlay.callout(text, {
      accent: config.accent,
      background: hexToRgba(config.background, 0.94),
      foreground: config.foreground,
      fontSizePx: config.fontSizePx,
      ...(options.at ? { at: options.at } : {}),
    });
    await delay(options.dwellMs ?? Math.min(config.dwellMs, 1200));
    await overlay.callout('', { ...(options.at ? { at: options.at } : {}) }).catch(() => {});
    await overlay.clear().catch(() => {});
  }

  /** Called by the session after an action so the recording shows what was touched. */
  async noteAction(position: { x: number; y: number } | null, pressed = true): Promise<void> {
    const state = this.state;
    if (!state?.active || !state.overlay || !state.cursorEnabled) return;
    if (position) {
      await state.overlay.cursor(position, pressed);
      if (pressed) await delay(70);
      await state.overlay.cursor(position, false);
    }
  }

  status(): RecordingState {
    if (!this.state) {
      return {
        active: false,
        backend: null,
        startedAt: null,
        elapsedMs: 0,
        frames: 0,
        fps: this.config.recording.fps,
        chapters: [],
        label: null,
        pageId: null,
        warnings: [],
      };
    }
    const state = this.state;
    return {
      active: state.active,
      backend: state.backend,
      startedAt: state.startedIso,
      elapsedMs: state.active ? Date.now() - state.startedAt : state.frames.at(-1)?.atMs ?? 0,
      frames: state.frames.length,
      fps: state.fps,
      chapters: state.chapters,
      label: state.label,
      pageId: state.pageId,
      warnings: state.warnings,
    };
  }

  async stop(options: { output?: string; finalize?: boolean; convert?: boolean; poster?: boolean } = {}): Promise<StopResult> {
    const state = this.state;
    if (!state || !state.active) {
      throw new LensError({
        code: LensErrorCode.RECORDING_NOT_ACTIVE,
        message: 'No recording is active in this session.',
        scope: 'input',
        hints: ['Start one with `lens record start --label my-demo`.'],
      });
    }

    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }

    if (state.backend === 'context-video') {
      state.active = false;
      state.pendingCloseExport = true;
      const counts = this.host.observationCounts(state.pageId, 0);
      return {
        ok: true,
        backend: 'context-video',
        durationMs: Date.now() - state.startedAt,
        frames: -1,
        fps: state.fps,
        coverageRatio: 1,
        chapters: state.chapters,
        artifacts: [],
        warnings: [
          'context-video records for the whole session: the WebM is written when the session closes (`lens close`) or with `lens record export`.',
        ],
        stats: { ...counts, actions: this.host.actionCount() },
        video: { width: null, height: null, durationMs: null },
        pending: true,
      };
    }

    if (this.cdp) {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      if (this.screencastListener) this.cdp.off('Page.screencastFrame', this.screencastListener as never);
      this.screencastListener = null;
      this.cdp = null;
    }
    await state.overlay?.clear().catch(() => {});

    const durationMs = Date.now() - state.startedAt;
    // Hold the last frame briefly so the ending is visible rather than clipped.
    if (state.frames.length) {
      const last = state.frames[state.frames.length - 1]!;
      state.frames.push({ ...last, atMs: durationMs + 350, file: last.file });
    }

    const manifest = path.join(state.dir, 'recording.json');
    const warnings = [...state.warnings];
    const frameCount = state.frames.length;
    const activeSpan = state.frames.length ? state.frames.at(-1)!.atMs - state.frames[0]!.atMs : 0;
    const coverageRatio = durationMs > 0 ? Math.min(1, activeSpan / durationMs) : 0;

    await writeJson(manifest, {
      schema: 1,
      label: state.label,
      startedAt: state.startedIso,
      endedAt: isoNow(),
      durationMs,
      fps: state.fps,
      backend: state.backend,
      frames: state.frames.map((f) => ({ ...f, file: path.basename(f.file) })),
      chapters: state.chapters,
      coverageRatio: Math.round(coverageRatio * 1000) / 1000,
      warnings,
      page: { id: state.pageId },
    });

    const artifacts: RecordedArtifact[] = [];
    let webm: string | undefined;
    let mp4: string | undefined;
    let poster: string | undefined;

    if (frameCount === 0) {
      warnings.push('No frames were captured — the page never repainted during the recording.');
    } else {
      const target = options.output ?? path.join(state.dir, `${state.label}.webm`);
      const encoded = await this.encode(state, target, durationMs);
      if (encoded) {
        webm = encoded;
        const bytes = (await fileSize(encoded)) ?? 0;
        artifacts.push({ kind: 'webm', path: this.host.relative(encoded), bytes });
        if ((state.format === 'mp4' || state.format === 'both' || this.config.recording.convert !== 'never') && encoded.endsWith('.webm')) {
          const converted = await convertVideo(encoded, encoded.replace(/\.webm$/, '.mp4'), this.config);
          if (converted.ok && converted.output) {
            mp4 = converted.output;
            artifacts.push({ kind: 'mp4', path: this.host.relative(mp4), bytes: (await fileSize(mp4)) ?? 0 });
          } else if (converted.skippedReason) {
            warnings.push(`MP4 skipped: ${converted.skippedReason}`);
          } else if (converted.stderr) {
            warnings.push(`MP4 conversion failed: ${converted.stderr.split('\n')[0]}`);
          }
        }
      } else {
        artifacts.push({ kind: 'frames', path: this.host.relative(path.join(state.dir, 'frames')), bytes: frameCount });
        warnings.push(
          'Frames were kept but no video was encoded. Install ffmpeg (or `npm i -D @ffmpeg-installer/ffmpeg`) to produce WebM/MP4 — `lens doctor` shows what was searched.',
        );
      }
      const posterFrame = pickPosterFrame(state.frames, state.chapters[0]?.atMs);
      if (posterFrame && (options.poster ?? true)) {
        poster = path.join(state.dir, `${state.label}-poster.jpg`);
        await fs.promises.copyFile(posterFrame.file, poster).catch(() => {});
        if (fs.existsSync(poster)) artifacts.push({ kind: 'poster', path: this.host.relative(poster), bytes: (await fileSize(poster)) ?? 0 });
      }
    }

    artifacts.push({ kind: 'manifest', path: this.host.relative(manifest), bytes: (await fileSize(manifest)) ?? 0 });
    if (state.chapters.length) {
      const chaptersFile = path.join(state.dir, 'chapters.json');
      await writeJson(chaptersFile, state.chapters);
      artifacts.push({ kind: 'chapters', path: this.host.relative(chaptersFile), bytes: (await fileSize(chaptersFile)) ?? 0 });
    }

    let trace: string | undefined;
    if (this.config.recording.trace.enabled && this.host.trace?.isActive) {
      const tracePath = path.join(this.host.config.artifactPath, 'traces', `${state.label}.trace.zip`);
      const result = await this.host.trace.stop(tracePath).catch((err) => {
        warnings.push(`Trace not written: ${(err as Error).message.split('\n')[0]}`);
        return null;
      });
      if (result) {
        trace = result.path;
        artifacts.push({ kind: 'trace', path: this.host.relative(trace), bytes: result.bytes });
      }
    }

    const video = webm ? await probeVideo(webm) : { durationMs: null, width: null, height: null, fps: null };
    const counts = this.host.observationCounts(state.pageId, 0);

    if (frameCount > 0 && coverageRatio < 0.25) {
      warnings.push(`Only ${Math.round(coverageRatio * 100)}% of the recording length contained visual change — the demo may be too static.`);
    }

    this.state = null;
    await this.cleanupFrames(state, { videoProduced: Boolean(webm) });

    return {
      ok: frameCount > 0,
      backend: 'screencast',
      durationMs,
      frames: frameCount,
      fps: state.fps,
      coverageRatio: Math.round(coverageRatio * 1000) / 1000,
      webm,
      mp4,
      poster,
      trace,
      chapters: state.chapters,
      artifacts,
      warnings,
      stats: { ...counts, actions: this.host.actionCount() },
      video: { width: video.width, height: video.height, durationMs: video.durationMs },
      manifest,
    };
  }

  /** Assemble frames into video. Returns null when no encoder is available. */
  private async encode(state: NonNullable<typeof this.state>, target: string, durationMs: number): Promise<string | null> {
    const ffmpeg = findFfmpeg(this.config);
    if (!ffmpeg) return null;

    const listFile = path.join(state.dir, 'frames.txt');
    const lines: string[] = [];
    for (let index = 0; index < state.frames.length; index += 1) {
      const frame = state.frames[index]!;
      const next = state.frames[index + 1];
      const holdMs = next ? Math.max(20, next.atMs - frame.atMs) : Math.max(250, Math.min(900, durationMs * 0.02));
      lines.push(`file '${path.basename(frame.file).replace(/'/g, "'\\''")}'`);
      lines.push(`duration ${(holdMs / 1000).toFixed(3)}`);
    }
    // The concat demuxer needs the final entry repeated to honour its duration.
    if (state.frames.length) lines.push(`file '${path.basename(state.frames.at(-1)!.file)}'`);
    await fs.promises.writeFile(listFile, lines.join('\n'));

    const { spawn } = await import('node:child_process');
    const isMp4 = target.endsWith('.mp4');
    const args = [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-vf',
      `fps=${state.fps},format=yuv420p`,
      '-vsync',
      'cfr',
      ...(isMp4
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-movflags', '+faststart']
        : ['-c:v', 'libvpx', '-b:v', `${state.bitRateKbps}k`, '-cpu-used', '4', '-auto-alt-ref', '0', '-deadline', 'realtime']),
      target,
    ];

    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(ffmpeg.path, args, { cwd: state.dir, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, Math.max(60_000, durationMs * 2));
      child.on('error', () => {
        clearTimeout(killer);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(killer);
        if (code !== 0) log.debug('ffmpeg encode failed', { code, stderr: stderr.slice(0, 400) });
        resolve(code === 0 && fs.existsSync(target));
      });
    });

    if (!ok) return null;
    await fs.promises.rm(listFile, { force: true }).catch(() => {});
    return target;
  }

  /** Export Playwright context video after the pages have closed. */
  async exportSessionVideo(outputDir?: string): Promise<RecordedArtifact[]> {
    const out: RecordedArtifact[] = [];
    if (!this.sessionVideoPages.size) return out;
    const dir = outputDir ?? path.join(this.config.artifactPath, this.config.recording.dir);
    await ensureDir(dir);
    for (const [, entry] of this.sessionVideoPages) {
      try {
        const video = entry.page.video();
        if (!video) continue;
        const source = await video.path();
        const target = path.join(dir, `${entry.label}.webm`);
        await fs.promises.copyFile(source, target);
        out.push({ kind: 'webm', path: this.host.relative(target), bytes: (await fileSize(target)) ?? 0 });
        if (this.config.recording.convert !== 'never') {
          const converted = await convertVideo(target, target.replace(/\.webm$/, '.mp4'), this.config);
          if (converted.ok && converted.output) out.push({ kind: 'mp4', path: this.host.relative(converted.output), bytes: (await fileSize(converted.output)) ?? 0 });
        }
      } catch (err) {
        log.debug('session video export failed', { error: (err as Error).message });
      }
    }
    this.sessionVideoPages.clear();
    return out;
  }

  private playwrightFfmpegReady(): boolean {
    return provisionPlaywrightFfmpeg() !== null;
  }

  private async viewportSize(page: Page): Promise<{ width: number; height: number }> {
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null);
    return size ?? { width: this.config.viewport.width, height: this.config.viewport.height };
  }

  /**
   * Frames move into `frames/` when they are the deliverable (no encoder) or the
   * user asked to keep them; otherwise they are deleted so `.lens` stays tidy.
   */
  private async cleanupFrames(state: NonNullable<typeof this.state>, policy: { videoProduced: boolean }): Promise<void> {
    const keep = this.config.recording.keepFrames || !policy.videoProduced;
    if (!keep) {
      for (const frame of state.frames) await fs.promises.rm(frame.file, { force: true }).catch(() => {});
      return;
    }
    const framesDir = path.join(state.dir, 'frames');
    await ensureDir(framesDir);
    for (const frame of state.frames) {
      await fs.promises.rename(frame.file, path.join(framesDir, path.basename(frame.file))).catch(() => {});
    }
  }

  async snapshotPoster(pageId?: string | null): Promise<string> {
    const managed = this.host.pageFor(pageId);
    const file = await this.host.allocate('recordings', `poster-${safeName(this.state?.label ?? 'poster', 'poster')}`, '.jpg');
    const buffer = await managed.page.screenshot({ type: 'jpeg', quality: 88 });
    await fs.promises.writeFile(file, buffer);
    return file;
  }
}

function pickPosterFrame(frames: FrameRecord[], chapterAtMs?: number): FrameRecord | null {
  if (!frames.length) return null;
  const wanted = chapterAtMs === undefined ? frames[Math.floor(frames.length * 0.35)]!.atMs : chapterAtMs;
  let best = frames[0]!;
  for (const frame of frames) {
    if (Math.abs(frame.atMs - wanted) < Math.abs(best.atMs - wanted)) best = frame;
  }
  return best;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function hexToRgba(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const int = Number.parseInt(match[1] ?? '0b1220', 16);
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
