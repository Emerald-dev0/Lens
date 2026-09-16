/** Shared vocabulary for everything that produces findings (review, tests, showcases). */

export type FindingSeverity = 'error' | 'warning' | 'info' | 'pass';

export type Verdict = 'pass' | 'warn' | 'fail';

export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FindingElement {
  /** Interaction reference from a snapshot, when one exists. */
  ref?: string;
  role?: string;
  name?: string;
  selector?: string;
  bounds?: ElementBounds;
  /** Extra computed style facts worth surfacing to an agent. */
  style?: Record<string, string | number>;
  count?: number;
}

export interface FindingArtifact {
  path: string;
  label?: string;
}

export interface Finding {
  /** Stable check id, e.g. `contrast`, `layout-overflow`. */
  check: string;
  severity: FindingSeverity;
  /** One line an agent can act on. */
  message: string;
  detail?: string;
  element?: FindingElement;
  /** Which viewport produced this, for responsive runs. */
  viewport?: string;
  /** URL/route/section the finding belongs to. */
  location?: string;
  suggestion?: string;
  artifacts?: FindingArtifact[];
  /** Machine data for downstream tooling (ratios, counts). */
  meta?: Record<string, unknown>;
}

export function finding(
  check: string,
  severity: FindingSeverity,
  message: string,
  extra: Partial<Omit<Finding, 'check' | 'severity' | 'message'>> = {},
): Finding {
  return { check, severity, message, ...extra };
}

export function summarizeFindings(findings: readonly Finding[]): {
  errors: number;
  warnings: number;
  infos: number;
  passes: number;
  byCheck: Record<string, number>;
} {
  const byCheck: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let passes = 0;
  for (const f of findings) {
    byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;
    if (f.severity === 'error') errors += 1;
    else if (f.severity === 'warning') warnings += 1;
    else if (f.severity === 'info') infos += 1;
    else passes += 1;
  }
  return { errors, warnings, infos, passes, byCheck };
}

export function verdictLabel(verdict: Verdict): string {
  return verdict === 'pass' ? 'PASS' : verdict === 'warn' ? 'WARNING' : 'FAIL';
}

export function worstVerdict(a: Verdict, b: Verdict): Verdict {
  const rank: Record<Verdict, number> = { pass: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}
