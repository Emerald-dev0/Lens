/**
 * Console observation.
 *
 * Captures console output, uncaught exceptions and page errors per tab, in an
 * append-only ring buffer with a monotonic sequence. Workflows read `since(seq)`
 * so a test step can attribute a new error to itself instead of to page history.
 */
import type { Page } from 'playwright-core';

import type { LensConfig } from '../config/schema.js';
import { maybeRedact } from '../security/redact.js';

export type ConsoleLevel = 'log' | 'info' | 'warning' | 'error' | 'debug' | 'trace';

export interface ConsoleEntry {
  /** Monotonic within a session. */
  seq: number;
  at: string;
  pageId: string;
  level: ConsoleLevel;
  text: string;
  source: 'console' | 'pageerror' | 'request';
  location?: { url: string; lineNumber?: number; columnNumber?: number };
  stack?: string;
  /** Count of identical consecutive messages (Chromium batches repeats). */
  repeated?: number;
}

export interface ConsoleSummary {
  total: number;
  errors: number;
  warnings: number;
  byLevel: Record<string, number>;
  firstErrorAt?: string;
}

const LEVEL_MAP: Record<string, ConsoleLevel> = {
  log: 'log',
  info: 'info',
  warning: 'warning',
  warn: 'warning',
  error: 'error',
  debug: 'debug',
  trace: 'trace',
  verbose: 'debug',
};

export class ConsoleCollector {
  private entries: ConsoleEntry[] = [];
  private seq = 0;
  private readonly attached = new Set<string>();

  constructor(private readonly config: LensConfig) {}

  attach(page: Page, pageId: string): void {
    if (this.config.console.enabled === false) return;
    if (this.attached.has(pageId)) return;
    this.attached.add(pageId);

    page.on('console', (msg) => {
      const level = LEVEL_MAP[msg.type()] ?? 'log';
      const location = msg.location();
      this.push({
        pageId,
        level,
        text: cleanText(msg.text()),
        source: 'console',
        location: location?.url
          ? { url: location.url, lineNumber: location.lineNumber, columnNumber: location.columnNumber }
          : undefined,
      });
    });

    page.on('pageerror', (error) => {
      this.push({
        pageId,
        level: 'error',
        text: cleanText(error.message || String(error)),
        source: 'pageerror',
        stack: this.config.console.captureStack ? cleanStack(error.stack) : undefined,
      });
    });

    page.on('crash', () => {
      this.push({ pageId, level: 'error', text: 'Page renderer crashed.', source: 'pageerror' });
    });
  }

  private push(partial: Omit<ConsoleEntry, 'seq' | 'at'>): ConsoleEntry {
    this.seq += 1;
    const redacted = maybeRedact(this.config, partial.text);
    const entry: ConsoleEntry = {
      ...partial,
      text: redacted.value,
      at: new Date().toISOString(),
      seq: this.seq,
    };

    const limit = this.config.console.maxEntries;
    const previous = this.entries[this.entries.length - 1];
    if (previous && previous.pageId === entry.pageId && previous.level === entry.level && previous.text === entry.text && previous.source === entry.source) {
      previous.repeated = (previous.repeated ?? 1) + 1;
      return previous;
    }

    this.entries.push(entry);
    if (this.entries.length > limit) this.entries.splice(0, this.entries.length - limit);
    return entry;
  }

  all(): ConsoleEntry[] {
    return [...this.entries];
  }

  /** Entries with a sequence greater than `sinceSeq`. */
  since(sinceSeq: number): ConsoleEntry[] {
    return this.entries.filter((e) => e.seq > sinceSeq);
  }

  forPage(pageId: string, sinceSeq = 0): ConsoleEntry[] {
    return this.entries.filter((e) => e.pageId === pageId && e.seq > sinceSeq);
  }

  problems(pageId?: string, sinceSeq = 0): ConsoleEntry[] {
    const tracked = new Set<ConsoleLevel>(this.config.console.levels as ConsoleLevel[]);
    return this.entries.filter(
      (e) => (pageId ? e.pageId === pageId : true) && e.seq > sinceSeq && (tracked.has(e.level) || e.source === 'pageerror'),
    );
  }

  lastError(pageId?: string): ConsoleEntry | null {
    const list = this.problems(pageId);
    return list.length ? (list[list.length - 1] as ConsoleEntry) : null;
  }

  summary(pageId?: string, sinceSeq = 0): ConsoleSummary {
    const list = pageId ? this.forPage(pageId, sinceSeq) : this.entries.filter((e) => e.seq > sinceSeq);
    const byLevel: Record<string, number> = {};
    let errors = 0;
    let warnings = 0;
    let firstErrorAt: string | undefined;
    for (const entry of list) {
      byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;
      if (entry.level === 'error') {
        errors += 1;
        firstErrorAt ??= entry.at;
      } else if (entry.level === 'warning') warnings += 1;
    }
    return { total: list.length, errors, warnings, byLevel, firstErrorAt };
  }

  clear(): void {
    this.entries = [];
  }
}

function cleanText(text: string): string {
  return text.replace(/\u0000/g, '').slice(0, 4000);
}

function cleanStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  return stack.split('\n').slice(0, 8).join('\n').slice(0, 2000);
}
