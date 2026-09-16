/**
 * Secret/sensitive-data redaction.
 *
 * Lens writes evidence — snapshots, reports, session logs, artifacts. Those files
 * outlive the terminal. Anything that looks like a credential is masked before it
 * is persisted, and the redaction is recorded rather than silently applied.
 */
import type { LensConfig } from '../config/schema.js';

export const REDACTION = '[redacted]';

/** Field/label names that imply a secret. */
export const SENSITIVE_KEY_WORDS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'access_key',
  'accesskey',
  'private_key',
  'privatekey',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'session',
  'sessionid',
  'cookie',
  'cvv',
  'cvc',
  'cardnumber',
  'card_number',
  'pan',
  'ssn',
  'social_security',
  'dob',
  'dateofbirth',
  'passport',
  'license',
  'iban',
  'routing',
  'pin',
  'otp',
  'mfa',
  '2fa',
  'recovery',
  'signature',
  'xapikey',
];

const VALUE_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'bearer', re: /\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi },
  { kind: 'bearer', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g },
  { kind: 'api-key', re: /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abprs]|glpat|ya29|AIza)[-_][A-Za-z0-9_-]{12,}\b/g },
  { kind: 'aws-key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'secret-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]{3,}@[^\s/]+/gi },
  { kind: 'key=value', re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|auth|authorization|session[_-]?id|cookie|otp|cvv|ssn|iban)\b\s*[:=]\s*(?:"[^"\n]{3,}"|'[^'\n]{3,}'|[^\s,;&"']{3,})/gi },
];

/** 13-19 digit runs that pass a Luhn check are masked as card numbers. */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

export interface RedactionResult {
  value: string;
  removed: number;
  kinds: string[];
}

export function redactText(input: string, extraPatterns: string[] = []): RedactionResult {
  let value = input;
  const kinds = new Set<string>();
  let removed = 0;

  for (const { kind, re } of [...VALUE_PATTERNS, ...compileExtra(extraPatterns)]) {
    value = value.replace(re, (match) => {
      removed += 1;
      kinds.add(kind);
      return preserveAssignment(match, kind);
    });
  }

  value = value.replace(CARD_CANDIDATE, (match) => {
    if (!passesLuhn(match)) return match;
    removed += 1;
    kinds.add('card');
    return match.replace(/\d/g, (d, i) => (i > match.length - 6 ? d : '•'));
  });

  return { value, removed, kinds: [...kinds] };
}

function compileExtra(patterns: string[]): Array<{ kind: string; re: RegExp }> {
  const out: Array<{ kind: string; re: RegExp }> = [];
  for (const p of patterns) {
    try {
      out.push({ kind: 'custom', re: new RegExp(p, 'gi') });
    } catch {
      // A bad user pattern must not break evidence capture.
    }
  }
  return out;
}

/** Keep `password=` style prefixes so agents still understand which field was masked. */
function preserveAssignment(match: string, kind: string): string {
  const assign = /^([A-Za-z0-9_.-]+\s*[:=]\s*)([\s\S]*)$/.exec(match);
  if (assign?.[1]) {
    const raw = assign[2] ?? '';
    const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : '';
    return `${assign[1]}${quote}${REDACTION}${quote}`;
  }
  if (kind === 'bearer' && /^[Bb]earer\b/.test(match)) return `Bearer ${REDACTION}`;
  return REDACTION;
}

function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function isSensitiveName(name: string | null | undefined): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_WORDS.some((word) => normalized.includes(word.replace(/[^a-z0-9]/g, '')));
}

export function isSensitiveInputType(type: string | null | undefined): boolean {
  if (!type) return false;
  return ['password', 'hidden', 'current-password', 'new-password', 'one-time-code'].includes(type.toLowerCase());
}

/** Deep-redact object payloads (report JSON, session logs) by key and by value. */
export function redactValue<T>(value: T, extraPatterns: string[] = []): { value: T; removed: number; keys: string[] } {
  const keys = new Set<string>();
  let removed = 0;

  const walk = (node: unknown, keyHint?: string): unknown => {
    if (typeof node === 'string') {
      const sensitiveKey = keyHint !== undefined && isSensitiveName(keyHint);
      const result = redactText(node, extraPatterns);
      if (sensitiveKey && node.length > 0) {
        removed += 1;
        if (keyHint) keys.add(keyHint);
        return REDACTION;
      }
      if (result.removed > 0) {
        removed += result.removed;
        for (const k of result.kinds) keys.add(k);
        return result.value;
      }
      return node;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, keyHint));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (isSensitiveName(k) && (typeof v === 'string' || typeof v === 'number')) {
          removed += 1;
          keys.add(k);
          out[k] = REDACTION;
        } else {
          out[k] = walk(v, k);
        }
      }
      return out;
    }
    return node;
  };

  return { value: walk(value) as T, removed, keys: [...keys] };
}

/** Applies redaction only when the config enables it. */
export function maybeRedact(config: LensConfig, text: string): RedactionResult {
  if (!config.security.redactSensitive) return { value: text, removed: 0, kinds: [] };
  return redactText(text, config.security.extraRedactPatterns);
}

export function maskSecret(value: string, visible = 0): string {
  if (value.length <= visible) return '•'.repeat(value.length);
  return `${'•'.repeat(Math.max(4, value.length - visible))}${value.slice(-visible)}`;
}
