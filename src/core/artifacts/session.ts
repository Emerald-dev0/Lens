/**
 * Session evidence.
 *
 * One `session.json` per Lens session records the target, every action taken,
 * artifacts produced, and everything the browser complained about. This is the
 * "proof of what was actually built" that agents hand back to a human.
 */
import path from 'node:path';

import type { LensConfig } from '../config/schema.js';
import type { ResolvedConfig } from '../config/load.js';
import { ensureDir, isoNow, pathExists, readJsonOpt, removeTree, safeName, writeJson } from '../util/fs.js';
import { ArtifactStore } from './paths.js';
import { redactValue } from '../security/redact.js';
import type { OriginClass } from '../security/policy.js';
import type { ViewportProfile } from '../config/schema.js';

export interface SessionArtifactRef {
  kind: 'screenshot' | 'recording' | 'trace' | 'report' | 'preview' | 'baseline' | 'frame' | 'flow-result';
  path: string;
  label?: string;
  bytes?: number;
  meta?: Record<string, unknown>;
}

export interface SessionAction {
  index: number;
  at: string;
  durationMs: number;
  op: string;
  /** Normalised arguments, redacted. */
  args?: Record<string, unknown>;
  ok: boolean;
  error?: { code: string; message: string; hints?: string[] };
  artifacts?: SessionArtifactRef[];
  /** Short agent-facing note, e.g. `clicked "Save" -> /projects`. */
  note?: string;
}

export interface SessionProblem {
  at: string;
  source: 'console' | 'network' | 'page';
  severity: 'error' | 'warning';
  message: string;
  url?: string;
  status?: number;
}

export interface SessionObservationSummary {
  consoleErrors: number;
  consoleWarnings: number;
  networkFailures: number;
  httpErrors: number;
  slowRequests: number;
}

export interface SessionRecord {
  schema: 1;
  id: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  result: 'in-progress' | 'success' | 'partial' | 'failed' | 'aborted';
  lens: { version: string; entry: 'cli' | 'mcp' | 'api' | 'test'; pid?: number };
  target: {
    url: string;
    origin: string;
    classification: OriginClass;
    title?: string;
  };
  viewport: ViewportProfile;
  browser: { engine: string; channel?: string; headless: boolean; executable?: string };
  policy: { mode: string; allowExternal: boolean; redactSensitive: boolean };
  actions: SessionAction[];
  artifacts: SessionArtifactRef[];
  observations?: SessionObservationSummary;
  /** Screenshots taken during the session, newest last — the quick "what did it look like" list. */
  screenshots?: string[];
  /** Everything the page complained about, in order. */
  errors?: SessionProblem[];
  networkFailures?: number;
  pages: Array<{ url: string; title?: string; firstSeen: string }>;
  /** Free-form notes the agent or Lens itself should see. */
  notes: string[];
  report?: string;
}

export class SessionLog {
  readonly record: SessionRecord;

  private constructor(
    readonly store: ArtifactStore,
    record: SessionRecord,
    private readonly config: LensConfig,
  ) {
    this.record = record;
  }

  static async create(
    config: ResolvedConfig,
    init: {
      id: string;
      entry: 'cli' | 'mcp' | 'api' | 'test';
      version: string;
      target: SessionRecord['target'];
      viewport: ViewportProfile;
      browser: SessionRecord['browser'];
      policy: SessionRecord['policy'];
    },
  ): Promise<SessionLog> {
    const store = new ArtifactStore(config);
    const dir = store.sessionDir(init.id);
    await ensureDir(dir);
    const record: SessionRecord = {
      schema: 1,
      id: init.id,
      startedAt: isoNow(),
      result: 'in-progress',
      lens: { version: init.version, entry: init.entry, pid: process.pid },
      target: init.target,
      viewport: init.viewport,
      browser: init.browser,
      policy: init.policy,
      actions: [],
      artifacts: [],
      pages: [],
      notes: [],
    };
    const log = new SessionLog(store, record, config);
    await log.flush();
    await log.updatePointer();
    return log;
  }

  static async load(config: ResolvedConfig, id: string): Promise<SessionRecord | null> {
    const store = new ArtifactStore(config);
    return readJsonOpt<SessionRecord>(path.join(store.sessionDir(id), 'session.json'));
  }

  static async latest(config: ResolvedConfig): Promise<SessionRecord | null> {
    const store = new ArtifactStore(config);
    return readJsonOpt<SessionRecord>(path.join(store.root, 'sessions', 'latest.json'));
  }

  get dir(): string {
    return this.store.sessionDir(this.record.id);
  }

  get filePath(): string {
    return path.join(this.dir, 'session.json');
  }

  addError(problem: SessionProblem): void {
    this.record.errors ??= [];
    this.record.errors.push(problem);
  }

  addNote(note: string): void {
    this.record.notes.push(note);
  }

  addPage(url: string, title?: string): void {
    if (this.record.pages.some((p) => p.url === url)) return;
    this.record.pages.push({ url, title, firstSeen: isoNow() });
  }

  addArtifact(ref: SessionArtifactRef): void {
    const rel = this.store.relative(ref.path);
    this.record.artifacts.push({ ...ref, path: rel });
  }

  startAction(op: string, args?: Record<string, unknown>): ActionHandle {
    const redacted = this.config.security.redactSensitive
      ? redactValue(args ?? {}, this.config.security.extraRedactPatterns).value
      : (args ?? {});
    const started = Date.now();
    const index = this.record.actions.length;
    return {
      index,
      finish: async (result: { ok?: boolean; artifacts?: SessionArtifactRef[]; error?: unknown; note?: string }) => {
        const entry: SessionAction = {
          index,
          at: isoNow(),
          durationMs: Date.now() - started,
          op,
          args: Object.keys(redacted).length ? redacted : undefined,
          ok: result.ok ?? !result.error,
          note: result.note,
        };
        if (result.error) {
          const err = result.error as { code?: string; message?: string; hints?: string[] };
          entry.error = { code: err.code ?? 'ERROR', message: err.message ?? String(result.error), hints: err.hints };
        }
        if (result.artifacts?.length) entry.artifacts = result.artifacts.map((a) => ({ ...a, path: this.store.relative(a.path) }));
        this.record.actions.push(entry);
        await this.flush();
        return entry;
      },
    };
  }

  setObservations(summary: SessionObservationSummary): void {
    this.record.observations = summary;
  }

  async finish(result: SessionRecord['result']): Promise<SessionRecord> {
    this.record.result = result;
    this.record.screenshots = this.record.artifacts.filter((a) => a.kind === 'screenshot').map((a) => a.path);
    this.record.networkFailures = this.record.observations?.networkFailures ?? this.record.errors?.filter((e) => e.source === 'network').length ?? 0;
    this.record.endedAt = isoNow();
    this.record.durationMs = new Date(this.record.endedAt).getTime() - new Date(this.record.startedAt).getTime();
    await this.flush();
    await this.updatePointer();
    return this.record;
  }

  async flush(): Promise<void> {
    const value = this.config.security.redactSensitive
      ? redactValue(this.record, this.config.security.extraRedactPatterns).value
      : this.record;
    await writeJson(this.filePath, value);
  }

  private async updatePointer(): Promise<void> {
    const dir = path.join(this.store.root, 'sessions');
    await ensureDir(dir);
    await writeJson(path.join(dir, 'latest.json'), {
      id: this.record.id,
      startedAt: this.record.startedAt,
      path: this.store.relative(this.filePath),
      result: this.record.result,
    });
    await writeJson(path.join(this.store.root, 'sessions', 'index.json'), await this.index());
  }

  private async index(): Promise<Array<{ id: string; startedAt: string; result: string; target: string; actions: number }>> {
    const sessionsRoot = path.join(this.store.root, 'sessions');
    const entries = await readJsonOpt<{ index?: unknown }>(path.join(sessionsRoot, 'index.json'));
    const list = Array.isArray(entries?.index) ? (entries.index as SessionRecordSummary[]) : [];
    const summary: SessionRecordSummary = {
      id: this.record.id,
      startedAt: this.record.startedAt,
      result: this.record.result,
      target: this.record.target.url,
      actions: this.record.actions.length,
    };
    const merged = [summary, ...list.filter((s) => s.id !== summary.id)].slice(0, 200);
    await writeJson(path.join(sessionsRoot, 'index.json'), { index: merged });
    return merged;
  }

  static async remove(config: ResolvedConfig, id: string): Promise<boolean> {
    const store = new ArtifactStore(config);
    const dir = store.sessionDir(safeName(id, id));
    if (!(await pathExists(dir))) return false;
    await removeTree(dir);
    return true;
  }
}

interface SessionRecordSummary {
  id: string;
  startedAt: string;
  result: string;
  target: string;
  actions: number;
}

export interface ActionHandle {
  index: number;
  finish(result: { ok?: boolean; artifacts?: SessionArtifactRef[]; error?: unknown; note?: string }): Promise<SessionAction>;
}
