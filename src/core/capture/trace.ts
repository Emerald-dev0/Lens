/**
 * Playwright trace integration.
 *
 * A trace is the debug-grade artifact: DOM snapshots, console, network and
 * screenshots per action, openable in the Playwright Trace Viewer. Lens records one
 * alongside every demo and every failing flow, and mirrors chapter titles into
 * `tracing.group()` so the timeline in the viewer matches the video's chapters.
 */
import path from 'node:path';

import type { BrowserContext, Page } from 'playwright-core';

import type { ResolvedConfig } from '../config/load.js';
import { LensError, LensErrorCode } from '../errors.js';
import { ensureDir } from '../util/fs.js';
import { log } from '../util/log.js';

export interface TraceHandle {
  startedAt: string;
  title: string;
  groups: Array<{ title: string; atMs: number }>;
  activeGroup: string | null;
}

export class TraceRecorder {
  private handle: TraceHandle | null = null;
  private context: BrowserContext | null = null;

  constructor(private readonly config: ResolvedConfig) {}

  get enabled(): boolean {
    return this.config.recording.trace.enabled;
  }

  get isActive(): boolean {
    return this.handle !== null;
  }

  async start(context: BrowserContext, options: { title?: string; page?: Page } = {}): Promise<boolean> {
    if (!this.enabled || this.handle) return false;
    this.context = context;
    const title = options.title ?? 'Lens session';
    try {
      await context.tracing.start({
        name: title.replace(/[^\w.-]+/g, '-').slice(0, 60),
        title,
        screenshots: this.config.recording.trace.screenshots,
        snapshots: this.config.recording.trace.snapshots,
        sources: this.config.recording.trace.sources,
      });
      this.handle = { startedAt: new Date().toISOString(), title, groups: [], activeGroup: null };
      return true;
    } catch (err) {
      log.debug('trace start failed', { error: (err as Error).message });
      this.handle = null;
      return false;
    }
  }

  /** Chapter markers become trace groups, so the viewer timeline matches the video. */
  async chapter(title: string): Promise<void> {
    if (!this.handle) return;
    if (this.handle.activeGroup) await this.context?.tracing.groupEnd().catch(() => {});
    try {
      await this.context?.tracing.group(title);
      this.handle.activeGroup = title;
      this.handle.groups.push({ title, atMs: Date.now() - new Date(this.handle.startedAt).getTime() });
    } catch (err) {
      log.debug('trace group failed', { error: (err as Error).message });
      this.handle.activeGroup = null;
    }
  }

  async stop(target: string): Promise<{ path: string; bytes: number } | null> {
    if (!this.handle || !this.context) return null;
    const active = this.handle.activeGroup;
    if (active) await this.context.tracing.groupEnd().catch(() => {});
    this.handle.activeGroup = null;
    await ensureDir(path.dirname(target));
    try {
      await this.context.tracing.stop({ path: target });
      const { fileSize } = await import('../util/fs.js');
      const bytes = (await fileSize(target)) ?? 0;
      this.handle = null;
      return { path: target, bytes };
    } catch (err) {
      this.handle = null;
      throw new LensError({
        code: LensErrorCode.RECORDING_FAILED,
        message: 'The trace could not be written.',
        scope: 'browser',
        detail: (err as Error).message.split('\n')[0],
        hints: ['The browser context may have closed mid-recording. The video and reports are still valid.'],
        cause: err,
      });
    }
  }

  status(): { active: boolean; title?: string; groups: Array<{ title: string; atMs: number }>; startedAt?: string } {
    if (!this.handle) return { active: false, groups: [] };
    return { active: true, title: this.handle.title, groups: this.handle.groups, startedAt: this.handle.startedAt };
  }
}
