/**
 * Flow schema.
 *
 * A flow is a *deliberate* sequence: every step either does something a user would
 * do or asserts something about the result. Flows power `lens test` (verify a real
 * journey works) and `lens showcase` (drive the product convincingly for a video).
 *
 * The same file shape serves both, because a good demonstration and a good test are
 * the same thing with different review criteria.
 */
import { z } from 'zod';

export const ACTION_KINDS = [
  'click',
  'dblclick',
  'hover',
  'type',
  'fill',
  'press',
  'select',
  'check',
  'uncheck',
  'drag',
  'scroll',
  'focus',
  'upload',
  'navigate',
] as const;

export const flowExpectationSchema = z
  .object({
    /** Substring or regex source the URL must match. */
    url: z.string().optional(),
    title: z.string().optional(),
    /** Text that must appear anywhere on the page. */
    text: z.string().optional(),
    textAny: z.array(z.string()).optional(),
    notText: z.string().optional(),
    /** Selector/ref that must be visible. */
    visible: z.string().optional(),
    notVisible: z.string().optional(),
    enabled: z.string().optional(),
    /** Element count constraints. */
    count: z
      .object({
        target: z.string(),
        gte: z.number().int().nonnegative().optional(),
        lte: z.number().int().nonnegative().optional(),
        eq: z.number().int().nonnegative().optional(),
      })
      .optional(),
    /** Field value assertions. */
    value: z
      .object({
        target: z.string(),
        equals: z.string().optional(),
        contains: z.string().optional(),
        not: z.string().optional(),
      })
      .optional(),
    /** Attribute/localStorage style reads. */
    attribute: z.object({ target: z.string(), name: z.string(), equals: z.string() }).optional(),
    storage: z.object({ key: z.string(), contains: z.string().optional(), equals: z.string().optional() }).optional(),
    /** Visual review must not exceed this verdict ('pass' is strictest). */
    verdict: z.enum(['pass', 'warn', 'fail']).optional(),
    /** No new console errors / failed requests since the step started. */
    consoleClean: z.boolean().optional(),
    networkClean: z.boolean().optional(),
    /** URL must stop changing (client-side redirects, optimistic saves). */
    settled: z.boolean().optional(),
  })
  .strict();

export const flowStepSchema = z
  .object({
    /** Human label used in output, callouts and chapter titles. */
    label: z.string().optional(),
    /** Defaults to `act` when a target is present, `expect` when only checks are. */
    action: z.enum([...ACTION_KINDS, 'wait', 'expect', 'screenshot', 'review', 'chapter', 'observe', 'note', 'set']).optional(),
    target: z.string().optional(),
    /** Action payload: text, key, direction, amount, files, x/y, to… */
    text: z.string().optional(),
    key: z.string().optional(),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    direction: z.enum(['up', 'down', 'left', 'right', 'top', 'bottom', 'into-view']).optional(),
    amount: z.number().optional(),
    to: z.string().optional(),
    files: z.array(z.string()).optional(),
    options: z.array(z.string()).optional(),
    clear: z.boolean().optional(),
    delayMs: z.number().int().nonnegative().optional(),
    /** Navigation target for `navigate`/`open`. */
    url: z.string().optional(),
    /** Viewport profile name for this step (responsive journeys). */
    viewport: z.string().optional(),
    expect: flowExpectationSchema.optional(),
    /** Assertion-only steps can be listed inline without an `expect` wrapper. */
    assert: flowExpectationSchema.optional(),
    /** Capture a screenshot for this step (string overrides the label). */
    screenshot: z.union([z.boolean(), z.string()]).optional(),
    /** Run a visual review after this step and attach the verdict. */
    review: z.boolean().optional(),
    /** Mark a chapter in any active recording. */
    chapter: z.string().optional(),
    /** Show an on-screen callout while recording. */
    callout: z.string().optional(),
    /** Failures are reported as warnings instead of failing the flow. */
    optional: z.boolean().optional(),
    /** Retry the step this many times (stale refs, optimistic UI). */
    retries: z.number().int().min(0).max(5).optional(),
    timeoutMs: z.number().int().positive().optional(),
    /** Extract a value for later `${name}` interpolation. */
    save: z
      .object({
        as: z.string(),
        from: z.enum(['text', 'value', 'url', 'title', 'count', 'storage']).default('text'),
        target: z.string().optional(),
        pattern: z.string().optional(),
        group: z.number().int().nonnegative().default(1),
      })
      .optional(),
    /** Named variable assignments for `set`. */
    vars: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    /** Only run when these match the environment (framework, mode, flag). */
    when: z
      .object({
        env: z.string().optional(),
        hasVariable: z.string().optional(),
        viewport: z.string().optional(),
      })
      .optional(),
    /** Free-form note for the report and reviewers. */
    note: z.string().optional(),
  })
  .strict();

export const flowSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /** Where to start. Relative URLs resolve against the configured base URL. */
    startUrl: z.string().optional(),
    url: z.string().optional(),
    /** Applied for the duration of the flow, then restored. */
    viewport: z.string().optional(),
    /** Screenshot every step (default: only failures and `screenshot: true`). */
    captureEveryStep: z.boolean().optional(),
    /** Abort on the first failed step. Default true; false collects all results. */
    failFast: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    /** Setup that must run before the journey (seed data, login state). */
    before: z.array(flowStepSchema).optional(),
    steps: z.array(flowStepSchema).min(1),
    after: z.array(flowStepSchema).optional(),
    /** Showcase-specific presentation hints; ignored by `lens test`. */
    presentation: z
      .object({
        title: z.string().optional(),
        subtitle: z.string().optional(),
        callouts: z.boolean().default(true),
        chaptersFrom: z.enum(['label', 'chapter', 'none']).default('label'),
        pacingMs: z.number().int().nonnegative().default(600),
        endOnStrongestScreen: z.boolean().default(true),
      })
      .optional(),
  })
  .strict();

export type FlowExpectation = z.infer<typeof flowExpectationSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;
export type Flow = z.infer<typeof flowSchema>;
export type FlowActionKind = (typeof ACTION_KINDS)[number];

export const FLOW_STEP_ACTIONS = new Set<string>([...ACTION_KINDS, 'wait', 'expect', 'screenshot', 'review', 'chapter', 'observe', 'note', 'set']);
