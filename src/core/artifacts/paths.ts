/** Artifact layout: every piece of evidence Lens produces has a deterministic home. */
import path from 'node:path';

import type { ResolvedConfig } from '../config/load.js';
import { ensureDir, safeName, shortHash, timestampSlug } from '../util/fs.js';

export const ARTIFACT_KINDS = [
  'screenshots',
  'recordings',
  'reports',
  'traces',
  'previews',
  'baselines',
  'sessions',
  'frames',
  'flows',
  'profiles',
  'auth',
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export class ArtifactStore {
  readonly root: string;
  readonly projectRoot: string;

  constructor(config: ResolvedConfig) {
    this.projectRoot = config.root;
    this.root = config.artifactPath;
  }

  dir(kind: ArtifactKind, ...rest: string[]): string {
    return path.join(this.root, kind, ...rest);
  }

  async ensure(kind: ArtifactKind, ...rest: string[]): Promise<string> {
    const target = path.join(this.root, kind, ...rest);
    await ensureDir(target);
    return target;
  }

  /** Timestamped, collision-free file name inside a kind directory. */
  async allocate(kind: ArtifactKind, base: string, ext: string, subdir?: string): Promise<string> {
    const dir = this.dir(kind, ...(subdir ? [subdir] : []));
    await ensureDir(dir);
    const name = `${timestampSlug()}_${shortHash(base, 6)}_${safeName(base, 'capture')}${ext.startsWith('.') ? ext : `.${ext}`}`;
    return path.join(dir, name);
  }

  /** Stable file name for baselines and previews (overwritten deliberately). */
  pathIn(kind: ArtifactKind, fileName: string, subdir?: string): string {
    return path.join(this.root, kind, ...(subdir ? [subdir] : []), fileName);
  }

  /** Relative to the project root, for display in agent output. */
  relative(absolute: string): string {
    const rel = path.relative(this.projectRoot, absolute);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return absolute;
    return `./${rel.split(path.sep).join('/')}`;
  }

  manifestPath(): string {
    return path.join(this.root, 'manifest.json');
  }

  daemonFile(): string {
    return path.join(this.root, 'daemon.json');
  }

  daemonSocket(): string {
    return path.join(this.root, 'daemon.sock');
  }

  daemonLog(): string {
    return path.join(this.root, 'daemon.log');
  }

  sessionDir(sessionId: string): string {
    return this.dir('sessions', safeName(sessionId, 'session'));
  }

  profileDir(sessionId: string): string {
    return this.dir('profiles', safeName(sessionId, 'session'));
  }

  baselineDir(name: string): string {
    return this.dir('baselines', safeName(name, 'default'));
  }
}

export function extForFormat(format: 'png' | 'jpeg' | 'webp' | 'jpg'): string {
  return format === 'jpeg' ? '.jpg' : `.${format}`;
}
