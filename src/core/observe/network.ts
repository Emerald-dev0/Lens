/**
 * Network observation.
 *
 * A page can look perfect while its API is on fire. Lens records every request
 * with timing, status, transfer size and failure text, then classifies what an
 * agent should care about: transport failures, HTTP errors, timeouts, blocked
 * requests and slow calls. Static assets and dev-server pings are excluded from
 * failure accounting by default so hot-reload noise does not look like a bug.
 */
import type { Page, Request, Response } from 'playwright-core';

import type { LensConfig } from '../config/schema.js';
import { matchesGlob } from '../util/text.js';
import { maybeRedact } from '../security/redact.js';

export interface NetworkEntry {
  seq: number;
  pageId: string;
  method: string;
  url: string;
  /** Short host/path form for agent output. */
  target: string;
  resourceType: string;
  status: number | null;
  statusText: string | null;
  ok: boolean;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  sizeBytes: number | null;
  failure?: string;
  classified: NetworkClassification;
  frameUrl?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  bodyPreview?: string;
  pending: boolean;
}

export type NetworkClassification = 'ok' | 'failed' | 'http-error' | 'aborted' | 'blocked' | 'slow' | 'pending';

export interface NetworkSummary {
  total: number;
  completed: number;
  failed: number;
  httpErrors: number;
  blocked: number;
  aborted: number;
  slow: number;
  pending: number;
  bytes: number;
  slowest: Array<{ target: string; durationMs: number; status: number | null }>;
}

const BODY_CONTENT_TYPES = /(json|text|xml|javascript|html)/i;

export class NetworkCollector {
  private entries: NetworkEntry[] = [];
  private seq = 0;
  private readonly byRequest = new Map<Request, NetworkEntry>();
  private readonly attached = new Set<string>();

  constructor(private readonly config: LensConfig) {}

  attach(page: Page, pageId: string): void {
    if (this.config.network.enabled === false) return;
    if (this.attached.has(pageId)) return;
    this.attached.add(pageId);

    page.on('request', (request) => {
      this.seq += 1;
      const entry: NetworkEntry = {
        seq: this.seq,
        pageId,
        method: request.method(),
        url: request.url(),
        target: shorten(request.url()),
        resourceType: request.resourceType(),
        status: null,
        statusText: null,
        ok: false,
        startedAt: new Date().toISOString(),
        sizeBytes: null,
        classified: 'pending',
        pending: true,
        frameUrl: request.frame().url(),
      };
      this.entries.push(entry);
      this.trim();
      this.byRequest.set(request, entry);
    });

    page.on('response', (response) => {
      const entry = this.byRequest.get(response.request());
      if (!entry) return;
      void this.onResponse(response, entry);
    });

    page.on('requestfailed', (request) => {
      const entry = this.byRequest.get(request);
      if (!entry) return;
      const failureText = request.failure()?.errorText ?? 'request failed';
      entry.pending = false;
      entry.endedAt = new Date().toISOString();
      entry.durationMs = Date.now() - new Date(entry.startedAt).getTime();
      entry.failure = maybeRedact(this.config, failureText).value;
      entry.ok = false;
      entry.classified = /abort/i.test(failureText) ? 'aborted' : 'failed';
      this.byRequest.delete(request);
    });

    page.on('requestfinished', (request) => {
      const entry = this.byRequest.get(request);
      if (!entry) return;
      entry.pending = false;
      entry.endedAt ??= new Date().toISOString();
      entry.durationMs ??= Date.now() - new Date(entry.startedAt).getTime();
      if (entry.classified === 'pending') {
        entry.classified = entry.status !== null && entry.status >= 400 ? 'http-error' : entry.durationMs > this.config.network.slowMs ? 'slow' : 'ok';
        entry.ok = entry.status === null || entry.status < 400;
      }
      this.byRequest.delete(request);
    });
  }

  private async onResponse(response: Response, entry: NetworkEntry): Promise<void> {
    entry.status = response.status();
    entry.statusText = response.statusText() || null;
    entry.ok = entry.status < 400;
    if (entry.status >= 400) entry.classified = 'http-error';
    const headers = response.headers();
    if (headers['content-length']) entry.sizeBytes = Number(headers['content-length']);
    if (this.config.network.captureBodies && BODY_CONTENT_TYPES.test(headers['content-type'] ?? '')) {
      try {
        const text = await response.text().catch(() => '');
        if (text) {
          const max = this.config.network.maxBodyBytes;
          entry.bodyPreview = maybeRedact(this.config, text.slice(0, max)).value;
          entry.sizeBytes ??= Buffer.byteLength(text, 'utf8');
        }
      } catch {
        // A body that cannot be read is not worth failing an observation for.
      }
    }
  }

  private trim(): void {
    const limit = this.config.network.maxEntries;
    if (this.entries.length <= limit) return;
    const dropped = this.entries.splice(0, this.entries.length - limit);
    for (const entry of dropped) {
      for (const [request, mapped] of this.byRequest) {
        if (mapped === entry) this.byRequest.delete(request);
      }
    }
  }

  isIgnored(url: string): boolean {
    return (this.config.network.ignorePatterns ?? []).some((pattern) => matchesGlob(url, pattern));
  }

  /** Resource-type counts, useful for spotting an app that loads nothing. */
  resourceBreakdown(pageId?: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of pageId ? this.forPage(pageId) : this.entries) {
      out[entry.resourceType] = (out[entry.resourceType] ?? 0) + 1;
    }
    return out;
  }

  /**
   * Requests with no response and no failure event are still in flight. Their age is
   * recomputed at read time rather than by a timer, so a long poll shows up as slow
   * instead of silently disappearing.
   */
  private refreshPending(): void {
    for (const entry of this.entries) {
      if (!entry.pending) continue;
      entry.durationMs = Date.now() - new Date(entry.startedAt).getTime();
      if (entry.status === null && !entry.failure) {
        entry.classified = entry.durationMs > this.config.network.slowMs ? 'slow' : 'pending';
      }
    }
  }

  all(): NetworkEntry[] {
    this.refreshPending();
    return [...this.entries];
  }

  forPage(pageId: string, sinceSeq = 0): NetworkEntry[] {
    return this.entries.filter((e) => e.pageId === pageId && e.seq > sinceSeq);
  }

  since(sinceSeq: number): NetworkEntry[] {
    return this.entries.filter((e) => e.seq > sinceSeq);
  }

  /** Requests worth telling an agent about, ignoring noise patterns. */
  problems(pageId?: string, sinceSeq = 0): NetworkEntry[] {
    return this.entries.filter((e) => {
      if (pageId && e.pageId !== pageId) return false;
      if (e.seq <= sinceSeq) return false;
      if (this.isIgnored(e.url)) return false;
      return e.classified === 'failed' || e.classified === 'http-error' || e.classified === 'blocked';
    });
  }

  summary(pageId?: string, sinceSeq = 0): NetworkSummary {
    const list = pageId ? this.forPage(pageId, sinceSeq) : this.since(sinceSeq);
    let bytes = 0;
    const summary: NetworkSummary = {
      total: list.length,
      completed: 0,
      failed: 0,
      httpErrors: 0,
      blocked: 0,
      aborted: 0,
      slow: 0,
      pending: 0,
      bytes: 0,
      slowest: [],
    };
    for (const entry of list) {
      if (!entry.pending) summary.completed += 1;
      if (entry.sizeBytes) {
        bytes += entry.sizeBytes;
        summary.bytes += entry.sizeBytes;
      }
      switch (entry.classified) {
        case 'failed':
          summary.failed += 1;
          break;
        case 'http-error':
          summary.httpErrors += 1;
          break;
        case 'blocked':
          summary.blocked += 1;
          break;
        case 'aborted':
          summary.aborted += 1;
          break;
        case 'slow':
          summary.slow += 1;
          break;
        case 'pending':
          summary.pending += 1;
          break;
        default:
          break;
      }
      if (entry.durationMs !== undefined) summary.slowest.push({ target: entry.target, durationMs: entry.durationMs, status: entry.status });
    }
    summary.slowest.sort((a, b) => b.durationMs - a.durationMs);
    summary.slowest = summary.slowest.slice(0, 5);
    return summary;
  }

  /** Endpoints that failed more than once — usually the real bug, not the symptom. */
  repeatedFailures(pageId?: string): Array<{ target: string; count: number; statuses: Array<number | null> }> {
    const groups = new Map<string, NetworkEntry[]>();
    for (const entry of this.problems(pageId)) {
      const key = `${entry.method} ${entry.target}`;
      const list = groups.get(key) ?? [];
      list.push(entry);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([target, entries]) => ({ target, count: entries.length, statuses: [...new Set(entries.map((e) => e.status))] }))
      .filter((g) => g.count > 0)
      .sort((a, b) => b.count - a.count);
  }

  clear(): void {
    this.entries = [];
    this.byRequest.clear();
  }
}

function shorten(url: string): string {
  try {
    const parsed = new URL(url);
    const file = parsed.pathname.split('/').filter(Boolean).pop();
    if (parsed.protocol === 'data:') return `data:${file ?? 'url'}`;
    const path = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, '');
    return `${parsed.host}${path}${parsed.search ? `?${truncateQuery(parsed.search.slice(1))}` : ''}`;
  } catch {
    return url.slice(0, 120);
  }
}

function truncateQuery(query: string): string {
  const parts = query.split('&');
  const kept = parts.slice(0, 3).map((p) => (p.length > 28 ? `${p.slice(0, 28)}…` : p));
  return kept.join('&') + (parts.length > 3 ? `&+${parts.length - 3}` : '');
}
