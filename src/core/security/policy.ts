/**
 * Lens security policy.
 *
 * Lens runs in an isolated, disposable browser profile. Its permission model is
 * deliberately coarse and legible to an agent: local development targets are
 * allowed, anything else requires an explicit grant. Nothing about the user's
 * real browser session is read implicitly.
 */
import { LensError, LensErrorCode } from '../errors.js';
import type { LensConfig } from '../config/schema.js';
import { matchesGlob } from '../util/text.js';

export type OriginClass = 'local' | 'external' | 'file' | 'blank' | 'non-browser';

export type Decision =
  | { allow: true; classification: OriginClass; reason: string }
  | { allow: false; classification: OriginClass; reason: string; remedy: string[] };

export interface OriginInfo {
  url: string;
  origin: string | null;
  hostname: string | null;
  port: number | null;
  protocol: string;
  classification: OriginClass;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', '::', '']);

export function classifyOrigin(url: string): OriginClass {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'non-browser';
  }
  if (parsed.protocol === 'about:' || parsed.href === 'about:blank') return 'blank';
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return 'blank';
  if (parsed.protocol === 'file:') return 'file';
  const host = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return 'local';
  if (host.endsWith('.localhost')) return 'local';
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return 'local';
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return 'local';
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return 'local';
  return 'external';
}

export function describeOrigin(url: string): OriginInfo {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  return {
    url,
    origin: parsed ? parsed.origin : null,
    hostname: parsed ? parsed.hostname : null,
    port: parsed?.port ? Number(parsed.port) : null,
    protocol: parsed ? parsed.protocol.replace(':', '') : 'unknown',
    classification: classifyOrigin(url),
  };
}

/** Is this host treated as local (loopback, private ranges, or user-configured)? */
export function isLocalHost(url: string, config: LensConfig): boolean {
  const info = describeOrigin(url);
  if (info.classification === 'local') return true;
  const host = info.hostname ?? '';
  return (config.security.localHostnames ?? []).some((pattern) => matchesGlob(host, pattern));
}

export function checkNavigation(config: LensConfig, url: string): Decision {
  const classification = classifyOrigin(url);
  const sec = config.security;
  const host = describeOrigin(url).hostname ?? '';

  if (classification === 'file' && !sec.allowFileUrls) {
    return {
      allow: false,
      classification,
      reason: 'file:// navigation is disabled by default.',
      remedy: [
        'Serve the file over http://localhost instead (`lens demo up` serves the bundled sample app).',
        'Or set security.allowFileUrls to true in lens.config.json when you really need it.',
      ],
    };
  }

  const blocked = (sec.blockedOrigins ?? []).some((pattern) => matchesOriginPattern(url, pattern));
  if (blocked) {
    return {
      allow: false,
      classification,
      reason: `"${host}" matches security.blockedOrigins.`,
      remedy: ['Remove the entry from blockedOrigins if this target is intentionally in scope.'],
    };
  }

  const explicitAllow = (sec.allowedOrigins ?? []).some((pattern) => matchesOriginPattern(url, pattern));
  if (explicitAllow) {
    return { allow: true, classification, reason: `Matched security.allowedOrigins (${host}).` };
  }

  if (classification === 'local' || isLocalHost(url, config)) {
    return { allow: true, classification, reason: 'Local development target.' };
  }
  if (classification === 'blank' || classification === 'non-browser') {
    return { allow: true, classification, reason: 'Non-network document.' };
  }

  if (sec.allowExternal) {
    return { allow: true, classification, reason: 'security.allowExternal is enabled.' };
  }

  return {
    allow: false,
    classification,
    reason: `${host} is an external origin and Lens defaults to local-only browsing.`,
    remedy: [
      'Add --allow-external to this command for a one-off exception.',
      'Or add the origin to security.allowedOrigins in lens.config.json for a standing grant.',
      'If this URL was meant to be your dev server, confirm the server is running and pass the local URL (e.g. http://localhost:5173).',
    ],
  };
}

function matchesOriginPattern(url: string, pattern: string): boolean {
  const info = describeOrigin(url);
  const host = info.hostname ?? '';
  const origin = info.origin ?? '';
  const p = pattern.trim();
  if (!p) return false;
  if (p === origin || p === host) return true;
  if (p.includes('://')) return matchesGlob(origin, p) || matchesGlob(url, p);
  return matchesGlob(host, p) || matchesGlob(host, `*.${p}`);
}

export function assertNavigationAllowed(config: LensConfig, url: string): void {
  const decision = checkNavigation(config, url);
  if (decision.allow) return;
  throw new LensError({
    code: LensErrorCode.SECURITY_ORIGIN_BLOCKED,
    message: `Lens will not open ${url}.`,
    scope: 'input',
    detail: decision.reason,
    hints: decision.remedy,
    data: { url, classification: decision.classification },
  });
}

export type PermissionKey =
  | 'storageState'
  | 'externalNavigation'
  | 'fileUpload'
  | 'downloads'
  | 'clipboard'
  | 'grantPermissions'
  | 'persistProfile'
  | 'rawHtml';

export interface PermissionRequest {
  permission: PermissionKey;
  reason: string;
}

/** Capability gates beyond origin policy — each must be enabled deliberately. */
export function checkPermission(config: LensConfig, permission: PermissionKey): Decision {
  const sec = config.security;
  switch (permission) {
    case 'storageState':
      return sec.storageState
        ? { allow: true, classification: 'local', reason: 'A storage state file was explicitly configured.' }
        : denied(permission, 'No storageState configured.', ['Set security.storageState to a JSON file exported by `lens auth save`.']);
    case 'persistProfile':
      return config.browser.profileMode === 'persist'
        ? { allow: true, classification: 'local', reason: 'Profile persists across sessions in the artifact dir only.' }
        : { allow: true, classification: 'local', reason: 'Profile is ephemeral.' };
    case 'externalNavigation':
      return sec.allowExternal
        ? { allow: true, classification: 'external', reason: 'External navigation allowed.' }
        : denied(permission, 'External navigation requires an explicit grant.', ['Pass --allow-external, or configure security.allowedOrigins.']);
    case 'fileUpload':
    case 'downloads':
    case 'clipboard':
    case 'grantPermissions':
    case 'rawHtml':
      return { allow: true, classification: 'local', reason: `${permission} is permitted within the isolated Lens profile.` };
    default:
      return { allow: true, classification: 'local', reason: 'Default allow.' };
  }
}

function denied(permission: PermissionKey, reason: string, remedy: string[]): Decision {
  return { allow: false, classification: 'local', reason: `${permission}: ${reason}`, remedy };
}

export interface PolicySummary {
  mode: 'local-only' | 'allowlist' | 'permissive';
  allowExternal: boolean;
  allowedOrigins: string[];
  blockedOrigins: string[];
  redactSensitive: boolean;
  recordingGuards: boolean;
  profile: string;
  storageState: string | null;
}

export function summarizePolicy(config: LensConfig): PolicySummary {
  const allowExternal = config.security.allowExternal;
  const allowlist = config.security.allowedOrigins ?? [];
  return {
    mode: allowExternal ? 'permissive' : allowlist.length > 0 ? 'allowlist' : 'local-only',
    allowExternal,
    allowedOrigins: allowlist,
    blockedOrigins: config.security.blockedOrigins ?? [],
    redactSensitive: config.security.redactSensitive,
    recordingGuards: config.security.recordingGuards,
    profile: config.browser.profileMode,
    storageState: config.security.storageState ?? null,
  };
}
