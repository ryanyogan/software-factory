import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Script for the `fake` adapter. Strings in steps may use `{{prompt}}` (this turn's input),
 * `{{turn}}` (1-based turn number) and, inside `burst`, `{{i}}` (1-based index).
 */
export const FakeStep = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  /** Write a file (relative to cwd, must stay inside it): tool.call Write → tool.result → file.change. */
  z.object({ type: z.literal('write'), path: z.string().min(1), content: z.string() }),
  z.object({
    type: z.literal('tool'),
    name: z.string().min(1),
    input: z.unknown().optional(),
    output: z.string().default(''),
    isError: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('todo'),
    items: z.array(z.object({ text: z.string(), done: z.boolean() })),
  }),
  z.object({ type: z.literal('sleep'), ms: z.number().int().nonnegative() }),
  /** `count` assistant messages, `intervalMs` apart (latency measurement). */
  z.object({
    type: z.literal('burst'),
    count: z.number().int().positive().max(10_000),
    intervalMs: z.number().int().nonnegative().default(0),
    text: z.string().default('message {{i}}'),
  }),
  /** Emit an error event; `fatal: true` ends the session after this turn. */
  z.object({ type: z.literal('error'), message: z.string(), fatal: z.boolean().default(false) }),
  /** Throw: the turn fails (`error` + `turn.completed { isError: true }`), the session stays usable. */
  z.object({ type: z.literal('fail'), message: z.string() }),
]);
export type FakeStep = z.output<typeof FakeStep>;

export const FakeTurn = z.object({
  steps: z.array(FakeStep),
  /** Reported as this turn's `usage.costUsd`. */
  costUsd: z.number().nonnegative().default(0.01),
  result: z.string().optional(),
});
export type FakeTurn = z.output<typeof FakeTurn>;

export const FakeScript = z.object({
  /** Default: `resumeSessionId`, else `fake-<uuid>`. */
  sessionId: z.string().min(1).optional(),
  /** Delay before every step (ms). */
  stepDelayMs: z.number().int().nonnegative().default(0),
  /** `turns[n]` scripts turn n+1 (turn 1 = the initial prompt). */
  turns: z.array(FakeTurn).optional(),
  /** Template for every turn past `turns` (i.e. follow-ups). */
  followUp: FakeTurn.optional(),
});
export type FakeScript = z.output<typeof FakeScript>;
export type FakeScriptInput = z.input<typeof FakeScript>;

export const defaultFakeScript: FakeScriptInput = {
  turns: [
    {
      steps: [
        { type: 'message', text: 'Working on: {{prompt}}' },
        {
          type: 'write',
          path: 'sf-fake-turn-{{turn}}.md',
          content: '# Turn {{turn}}\n\n{{prompt}}\n',
        },
        { type: 'message', text: 'Done with turn {{turn}}.' },
      ],
      result: 'Done with turn {{turn}}.',
    },
  ],
  followUp: {
    steps: [
      { type: 'message', text: 'Follow-up received: {{prompt}}' },
      {
        type: 'write',
        path: 'sf-fake-turn-{{turn}}.md',
        content: '# Turn {{turn}}\n\n{{prompt}}\n',
      },
      { type: 'message', text: 'Done with turn {{turn}}.' },
    ],
    result: 'Done with turn {{turn}}.',
  },
};

/** Env var read by the fake adapter: inline JSON, or a path to a JSON file. */
export const FAKE_SCRIPT_ENV = 'SF_FAKE_SCRIPT';

export function parseFakeScript(raw: unknown): FakeScript {
  return FakeScript.parse(raw);
}

/** Script from an explicit value, else `SF_FAKE_SCRIPT` in `env`, else the default. */
export function loadFakeScript(
  explicit: FakeScriptInput | undefined,
  env: Record<string, string | undefined>,
): FakeScript {
  if (explicit) return parseFakeScript(explicit);
  const src = env[FAKE_SCRIPT_ENV]?.trim();
  if (!src) return parseFakeScript(defaultFakeScript);
  const json = src.startsWith('{') ? src : readFileSync(src, 'utf8');
  return parseFakeScript(JSON.parse(json));
}

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
