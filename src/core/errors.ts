/**
 * Lens errors.
 *
 * Every error that can reach an agent is a `LensError`: it carries a stable
 * `code`, a short human/agent-readable message, the underlying detail, and —
 * most importantly — `hints` describing what to do next. An agent should never
 * have to parse a stack trace to recover.
 */

/** Stable, machine-readable error codes. Keep these append-only. */
export const LensErrorCode = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  CLI_USAGE: 'CLI_USAGE',
  CLI_NO_SESSION: 'CLI_NO_SESSION',

  DAEMON_UNAVAILABLE: 'DAEMON_UNAVAILABLE',
  DAEMON_TIMEOUT: 'DAEMON_TIMEOUT',
  RPC_METHOD_UNKNOWN: 'RPC_METHOD_UNKNOWN',
  RPC_FAILED: 'RPC_FAILED',

  BROWSER_NOT_FOUND: 'BROWSER_NOT_FOUND',
  BROWSER_LAUNCH_FAILED: 'BROWSER_LAUNCH_FAILED',
  BROWSER_CRASHED: 'BROWSER_CRASHED',
  BROWSER_CLOSED: 'BROWSER_CLOSED',

  SESSION_NOT_STARTED: 'SESSION_NOT_STARTED',
  SESSION_ALREADY_STARTED: 'SESSION_ALREADY_STARTED',
  PAGE_NOT_FOUND: 'PAGE_NOT_FOUND',
  PAGE_CLOSED: 'PAGE_CLOSED',
  NO_ACTIVE_PAGE: 'NO_ACTIVE_PAGE',

  NAVIGATE_FAILED: 'NAVIGATE_FAILED',
  NAVIGATE_TIMEOUT: 'NAVIGATE_TIMEOUT',
  DEV_SERVER_UNAVAILABLE: 'DEV_SERVER_UNAVAILABLE',
  WAIT_TIMEOUT: 'WAIT_TIMEOUT',

  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  TARGET_STALE: 'TARGET_STALE',
  TARGET_NOT_ACTIONABLE: 'TARGET_NOT_ACTIONABLE',
  TARGET_NOT_VISIBLE: 'TARGET_NOT_VISIBLE',

  ACTION_FAILED: 'ACTION_FAILED',
  ACTION_UNSUPPORTED: 'ACTION_UNSUPPORTED',

  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_UNREADABLE: 'FILE_UNREADABLE',
  FILE_UNWRITABLE: 'FILE_UNWRITABLE',
  INVALID_INPUT: 'INVALID_INPUT',

  SECURITY_ORIGIN_BLOCKED: 'SECURITY_ORIGIN_BLOCKED',
  SECURITY_PERMISSION_REQUIRED: 'SECURITY_PERMISSION_REQUIRED',

  BASELINE_MISSING: 'BASELINE_MISSING',
  BASELINE_MISMATCH: 'BASELINE_MISMATCH',

  TOOL_MISSING: 'TOOL_MISSING',
  RECORDING_FAILED: 'RECORDING_FAILED',
  RECORDING_NOT_ACTIVE: 'RECORDING_NOT_ACTIVE',
  RENDER_FAILED: 'RENDER_FAILED',

  FLOW_INVALID: 'FLOW_INVALID',
  FLOW_NOT_FOUND: 'FLOW_NOT_FOUND',
  FLOW_STEP_FAILED: 'FLOW_STEP_FAILED',

  SHOWCASE_PLAN_INVALID: 'SHOWCASE_PLAN_INVALID',
  SHOWCASE_INCOMPLETE_BRIEF: 'SHOWCASE_INCOMPLETE_BRIEF',

  PROJECT_NOT_DETECTED: 'PROJECT_NOT_DETECTED',
  METADATA_TARGET_NOT_FOUND: 'METADATA_TARGET_NOT_FOUND',

  REVIEW_FAILED: 'REVIEW_FAILED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL: 'INTERNAL',
} as const;

export type LensErrorCodeT = (typeof LensErrorCode)[keyof typeof LensErrorCode];

/** How a failure should be interpreted by an agent. */
export type LensErrorScope = 'input' | 'environment' | 'browser' | 'application' | 'internal';

export interface LensErrorInit {
  code: LensErrorCodeT;
  message: string;
  scope?: LensErrorScope;
  detail?: string;
  hints?: string[];
  /** Extra structured context, e.g. `{ url, viewport, step }`. */
  data?: Record<string, unknown>;
  cause?: unknown;
  /** True when retrying the same call could plausibly succeed. */
  retryable?: boolean;
}

export class LensError extends Error {
  readonly code: LensErrorCodeT;
  readonly scope: LensErrorScope;
  readonly detail?: string;
  readonly hints: string[];
  readonly data?: Record<string, unknown>;
  readonly retryable: boolean;
  /** Exit code used by the CLI. */
  exitCode = 1;

  constructor(init: LensErrorInit) {
    super(init.message);
    this.name = 'LensError';
    this.code = init.code;
    this.scope = init.scope ?? 'internal';
    this.detail = init.detail;
    this.hints = init.hints ?? [];
    this.data = init.data;
    this.retryable = init.retryable ?? false;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, LensError);
  }

  /** Short, agent-facing rendering (no stack). */
  format(): string {
    const lines = [`Lens: ${this.message}`];
    if (this.detail) lines.push(`  ${indent(this.detail, 2)}`);
    if (this.hints.length) {
      lines.push('  Suggested actions:');
      for (const h of this.hints) lines.push(`    - ${h}`);
    }
    lines.push(`  code=${this.code} scope=${this.scope}${this.retryable ? ' retryable=yes' : ''}`);
    return lines.join('\n');
  }

  static usage(message: string, hints: string[] = []): LensError {
    return new LensError({ code: LensErrorCode.CLI_USAGE, message, scope: 'input', hints });
  }

  static notFound(what: string, hints: string[] = []): LensError {
    return new LensError({ code: LensErrorCode.FILE_NOT_FOUND, message: `${what} not found.`, scope: 'input', hints });
  }

  static invalidInput(message: string, hints: string[] = [], data?: Record<string, unknown>): LensError {
    return new LensError({ code: LensErrorCode.INVALID_INPUT, message, scope: 'input', hints, data });
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        scope: this.scope,
        detail: this.detail,
        hints: this.hints,
        data: this.data,
        retryable: this.retryable,
      },
    };
  }
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : pad + l))
    .join('\n');
}

export function isLensError(err: unknown): err is LensError {
  return err instanceof LensError;
}

/** Normalise anything thrown into an actionable LensError. */
export function toLensError(err: unknown, fallback?: Partial<LensErrorInit>): LensError {
  if (isLensError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new LensError({
    code: LensErrorCode.INTERNAL,
    message: fallback?.message ?? 'Lens encountered an unexpected failure.',
    scope: 'internal',
    detail: message,
    hints: fallback?.hints ?? ['Re-run with LENS_LOG=debug and report the output if it repeats.'],
    cause: err,
    ...fallback,
  });
}

/** Throw when a condition must hold, with an actionable message. */
export function assertLens(
  condition: unknown,
  init: LensErrorInit,
): asserts condition {
  if (!condition) throw new LensError(init);
}

/** Convenience builders for the most common recoverable failures. */
/** Alias kept so call sites read naturally in either style. */
export const LensErrors = {
  notFound: (what: string, hints: string[] = []): LensError => LensError.notFound(what, hints),
  usage: (message: string, hints: string[] = []): LensError => LensError.usage(message, hints),
  invalidInput: (message: string, hints: string[] = [], data?: Record<string, unknown>): LensError =>
    LensError.invalidInput(message, hints, data),
};
