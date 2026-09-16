/**
 * File-upload guard.
 *
 * Uploading a file is the one browser action that reads the agent's own disk and
 * sends it to the page. Lens therefore only uploads files that live inside the
 * project (or a directory explicitly allowed for the run), and refuses the
 * locations where credentials actually live — even for localhost.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DENIED_DIR_NAMES = ['.ssh', '.aws', '.gnupg', '.config/gh', '.azure', '.docker', '.kube'];
const DENIED_BASE_NAMES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.netrc', '.npmrc', '.pypirc', 'credentials', 'shadow'];
const DENIED_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.kdbx'];
const DENIED_DIR_MARKERS = [
  path.join('Library', 'Application Support', 'Google', 'Chrome'),
  path.join('.config', 'google-chrome'),
  path.join('AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  path.join('.mozilla', 'firefox'),
];

export interface UploadPathDecision {
  ok: boolean;
  reason: string;
  resolved: string;
  sizeBytes?: number;
}

export function isSafeUploadPath(
  file: string,
  root: string,
  options: { allowedDirs?: string[]; maxSizeBytes?: number } = {},
): UploadPathDecision {
  const resolved = path.resolve(root, expandHome(file));
  const fail = (reason: string): UploadPathDecision => ({ ok: false, reason, resolved });

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return fail('the file does not exist');
  }
  if (!stat.isFile()) return fail('the path is not a regular file');

  const maxBytes = options.maxSizeBytes ?? 128 * 1024 * 1024;
  if (stat.size > maxBytes) {
    return fail(`the file is ${Math.round(stat.size / 1024 / 1024)}MB, above the ${Math.round(maxBytes / 1024 / 1024)}MB upload limit`);
  }

  const real = safeRealpath(resolved);
  const base = path.basename(real).toLowerCase();
  const home = expandHome('~');

  if (DENIED_BASE_NAMES.includes(base)) return fail('the file name is on the credential denylist');
  if (DENIED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return fail('private-key file types are never uploaded');
  if (base === '.env' || base.startsWith('.env.')) return fail('environment files may contain secrets; export the value you need into a fixture instead');
  if (DENIED_DIR_NAMES.some((denied) => real.startsWith(path.join(home, denied)) || real.includes(`/${denied}/`))) {
    return fail('the file lives in a credential directory');
  }
  if (DENIED_DIR_MARKERS.some((marker) => real.includes(marker))) return fail('browser profile data is never uploaded');

  const inside = (dir: string): boolean => {
    const rel = path.relative(safeRealpath(dir), real);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  };

  const allowedDirs = [root, ...(options.allowedDirs ?? []).map((dir) => path.resolve(root, expandHome(dir)))];
  if (allowedDirs.some(inside)) return { ok: true, reason: 'inside an allowed directory', resolved: real, sizeBytes: stat.size };

  if (real.startsWith(os.tmpdir())) {
    return { ok: true, reason: 'inside the system temp directory', resolved: real, sizeBytes: stat.size };
  }

  return fail(
    `the file is outside the project root (${path.relative(home, real).startsWith('..') ? 'and not in a temp dir' : 'the home directory'}). ` +
      'Pass --allow-path <dir> to grant this run access to that location',
  );
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}
