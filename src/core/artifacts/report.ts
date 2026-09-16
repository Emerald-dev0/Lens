/**
 * Reports: the agent-facing summary of a Lens run.
 *
 * Every high-level workflow (review, responsive, test, showcase, compare, preview)
 * writes a paired `.md` + `.json` report. The markdown is for humans reading the PR
 * or the terminal; the JSON is for the agent to act on.
 */
import path from 'node:path';

import type { ResolvedConfig } from '../config/load.js';
import { humanDuration, isoNow, safeName, timestampSlug, writeText } from '../util/fs.js';
import { ArtifactStore } from './paths.js';
import type { Finding, FindingSeverity, Verdict } from '../review/types.js';

export interface ReportSection {
  heading: string;
  /** Pre-formatted lines; already agent-readable. */
  lines: string[];
}

export interface ReportArtifact {
  path: string;
  label?: string;
}

export interface ReportInput {
  /** e.g. `review`, `responsive`, `test`, `showcase`, `compare`, `preview`. */
  kind: string;
  title: string;
  verdict: Verdict;
  target?: string;
  durationMs?: number;
  summary: string;
  findings: Finding[];
  sections?: ReportSection[];
  artifacts?: ReportArtifact[];
  /** Machine payload kept alongside the markdown. */
  data?: Record<string, unknown>;
  /** Written to the report and to the terminal; use for next steps. */
  nextActions?: string[];
  markdownExtra?: string;
}

export interface WrittenReport {
  markdown: string;
  json: string;
  verdict: Verdict;
  counts: Record<FindingSeverity, number>;
  name: string;
}

export function computeVerdict(findings: readonly Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'error')) return 'fail';
  if (findings.some((f) => f.severity === 'warning')) return 'warn';
  return 'pass';
}

export function countSeverities(findings: readonly Finding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0, pass: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

export function verdictIcon(verdict: Verdict): string {
  return verdict === 'pass' ? 'PASS' : verdict === 'warn' ? 'WARNING' : 'FAIL';
}

export async function writeReport(config: ResolvedConfig, input: ReportInput): Promise<WrittenReport> {
  const store = new ArtifactStore(config);
  const dir = await store.ensure('reports');
  const name = `${timestampSlug()}_${safeName(input.kind, 'report')}`;
  const markdownPath = path.join(dir, `${name}.md`);
  const jsonPath = path.join(dir, `${name}.json`);
  const counts = countSeverities(input.findings);

  const lines: string[] = [];
  lines.push(`# ${input.title}`);
  lines.push('');
  lines.push(`- **Verdict:** ${verdictIcon(input.verdict)} (${input.verdict})`);
  lines.push(`- **Generated:** ${isoNow()}`);
  if (input.target) lines.push(`- **Target:** ${input.target}`);
  if (input.durationMs !== undefined) lines.push(`- **Duration:** ${humanDuration(input.durationMs)}`);
  lines.push(
    `- **Findings:** ${counts.error} error, ${counts.warning} warning, ${counts.info} info, ${counts.pass} pass`,
  );
  lines.push('');
  lines.push(input.summary);
  lines.push('');

  const bySeverity: FindingSeverity[] = ['error', 'warning', 'info', 'pass'];
  for (const severity of bySeverity) {
    const group = input.findings.filter((f) => f.severity === severity);
    if (!group.length) continue;
    lines.push(`## ${titleCase(severity)} (${group.length})`);
    lines.push('');
    for (const finding of group) lines.push(...renderFinding(finding));
    lines.push('');
  }

  for (const section of input.sections ?? []) {
    lines.push(`## ${section.heading}`);
    lines.push('');
    for (const line of section.lines) lines.push(line);
    lines.push('');
  }

  if (input.artifacts?.length) {
    lines.push('## Artifacts');
    lines.push('');
    for (const artifact of input.artifacts) {
      lines.push(`- ${artifact.label ? `**${artifact.label}:** ` : ''}\`${rel(config.root, artifact.path)}\``);
    }
    lines.push('');
  }

  if (input.nextActions?.length) {
    lines.push('## Recommended next actions');
    lines.push('');
    for (const action of input.nextActions) lines.push(`1. ${action}`);
    lines.push('');
  }

  if (input.markdownExtra) {
    lines.push(input.markdownExtra);
    lines.push('');
  }

  await writeText(markdownPath, `${lines.join('\n')}\n`);
  await writeText(
    jsonPath,
    `${JSON.stringify(
      {
        schema: 1,
        kind: input.kind,
        title: input.title,
        generatedAt: isoNow(),
        target: input.target,
        durationMs: input.durationMs,
        verdict: input.verdict,
        summary: input.summary,
        counts,
        findings: input.findings,
        sections: input.sections,
        artifacts: input.artifacts?.map((a) => ({ ...a, path: rel(config.root, a.path) })),
        nextActions: input.nextActions,
        data: input.data,
        markdown: rel(config.root, markdownPath),
      },
      null,
      2,
    )}\n`,
  );

  return { markdown: markdownPath, json: jsonPath, verdict: input.verdict, counts, name };
}

function renderFinding(finding: Finding): string[] {
  const out: string[] = [];
  const location = finding.location ? ` \`${finding.location}\`` : '';
  out.push(`- **${finding.check}${location}** — ${finding.message}`);
  if (finding.detail) out.push(`  - ${singleLine(finding.detail)}`);
  if (finding.element) {
    const parts: string[] = [];
    if (finding.element.ref) parts.push(`ref=${finding.element.ref}`);
    if (finding.element.role) parts.push(`role=${finding.element.role}`);
    if (finding.element.name) parts.push(`name="${truncate(finding.element.name, 60)}"`);
    if (finding.element.selector) parts.push(`selector=${finding.element.selector}`);
    if (finding.element.bounds) {
      parts.push(
        `box=${Math.round(finding.element.bounds.x)},${Math.round(finding.element.bounds.y)} ${Math.round(finding.element.bounds.width)}x${Math.round(finding.element.bounds.height)}`,
      );
    }
    if (parts.length) out.push(`  - element: ${parts.join(', ')}`);
  }
  if (finding.viewport) out.push(`  - viewport: ${finding.viewport}`);
  if (finding.suggestion) out.push(`  - fix: ${finding.suggestion}`);
  for (const artifact of finding.artifacts ?? []) {
    out.push(`  - evidence: \`${artifact.path}\`${artifact.label ? ` (${artifact.label})` : ''}`);
  }
  return out;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function singleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function rel(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return target;
  return `./${relative.split(path.sep).join('/')}`;
}
