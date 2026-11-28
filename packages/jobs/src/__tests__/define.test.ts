import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineJob } from '../define/define-job.ts';
import { gate } from '../define/gate.ts';
import { type LimiterRefs, limiterKey } from '../define/limits.ts';
import { mapStep } from '../define/map-step.ts';
import { createRegistry } from '../define/registry.ts';
import { type MapStepOutput, step } from '../define/step.ts';
import { JobDefinitionError } from '../model/errors.ts';
import { toyScoring, toyStopping } from '../testing/toy-jobs.ts';

const Input = z.object({ n: z.number() });
const Output = z.object({ line: z.number() });

const calibration = (batchMax = 2) =>
  defineJob({
    key: 'toy.calibration',
    input: Input,
    output: Output,
    steps: (s) =>
      s
        .add('band', step({ run: ({ input }) => ['a', 'b'].slice(0, input.n) }))
        .add(
          'judge',
          mapStep({
            items: ({ band }) => band,
            key: (ref, { input }) => `${input.n}:${ref}`,
            hydrate: async (refs) => refs.map((id) => ({ id, len: id.length })),
            run: async (batch) => batch.map((b) => b.item.len / 2),
            batch: { max: batchMax },
            limiter: 'toy',
          }),
        )
        .add(
          'line',
          step({ run: ({ judge }) => ({ line: judge.results.length }) }),
        ),
  });

describe('defineJob', () => {
  test('each step reads the input and the earlier outputs by name, typed', () => {
    const job = calibration();
    expect(job.steps.map((s) => [s.name, s.index, s.erased.kind])).toEqual([
      ['band', 0, 'step'],
      ['judge', 1, 'map'],
      ['line', 2, 'step'],
    ]);
    // The types flow: a later step sees an earlier output with its own type, and never a later one.
    defineJob({
      key: 'toy.types',
      input: Input,
      output: z.number(),
      steps: (s) =>
        s
          .add('a', step({ run: ({ input }) => input.n + 1 }))
          .add(
            'b',
            step({
              run: (ctx) => {
                const n: number = ctx.a;
                // @ts-expect-error a step never sees a later step's output
                return n + ctx.c;
              },
            }),
          )
          .add('c', step({ run: ({ a }) => a * 2 })),
    });
    defineJob({
      key: 'toy.types.map',
      input: Input,
      output: z.number(),
      steps: (s) =>
        s
          .add(
            'judge',
            mapStep({
              items: () => ['x'],
              key: (ref) => ref,
              run: async (batch) => batch.map(() => 0.5),
              batch: { max: 1 },
              limiter: 'toy',
            }),
          )
          .add(
            'count',
            step({
              run: ({ judge }) => {
                const out: MapStepOutput<number> = judge;
                return out.results.length;
              },
            }),
          ),
    });
  });

  test('the last step must produce the job output', () => {
    defineJob({
      key: 'toy.output',
      input: Input,
      output: Output,
      // @ts-expect-error the last step returns a number, not { line }
      steps: (s) => s.add('a', step({ run: () => 1 })),
    });
  });

  test('a duplicate or reserved step name, and a map step without a valid batch, are definition errors', () => {
    expect(() =>
      defineJob({
        key: 'toy.dup',
        input: Input,
        output: z.number(),
        steps: (s) =>
          s
            .add('a', step({ run: () => 1 }))
            // @ts-expect-error two steps named a
            .add('a', step({ run: () => 2 })),
      }),
    ).toThrow(JobDefinitionError);
    expect(() =>
      defineJob({
        key: 'toy.reserved',
        input: Input,
        output: z.number(),
        // @ts-expect-error input is the context's own
        steps: (s) => s.add('input', step({ run: () => 1 })),
      }),
    ).toThrow('may not be named input');
    expect(() =>
      mapStep({
        items: () => [],
        key: (r) => r,
        run: async () => [],
        batch: { max: 0 },
        limiter: 'toy',
      }),
    ).toThrow(JobDefinitionError);
  });
});

describe('limiter refs', () => {
  test('a name, a per-tenant ref or a list; taken sorted by name, a name never twice', () => {
    const judge = (limiter: LimiterRefs) =>
      mapStep({
        items: () => [],
        key: (r) => r,
        run: async () => [],
        batch: { max: 1 },
        limiter,
      }).erased;
    expect(judge('toy').limiters).toEqual([{ name: 'toy', per: 'global' }]);
    expect(
      judge(['llm-calls', { name: 'decisions', per: 'tenant' }])
        .limiters,
    ).toEqual([
      { name: 'decisions', per: 'tenant' },
      { name: 'llm-calls', per: 'global' },
    ]);
    expect(() => judge([])).toThrow('a map step names its limiter');
    expect(() => judge(['toy', { name: 'toy', per: 'tenant' }])).toThrow(
      'names the limiter toy twice',
    );
    expect(step({ run: () => 1 }).erased).toMatchObject({ limiters: [] });
    expect(
      step({ run: () => 1, limiter: { name: 'bands', per: 'tenant' } })
        .erased,
    ).toMatchObject({ limiters: [{ name: 'bands', per: 'tenant' }] });
    expect(
      limiterKey({ name: 'decisions', per: 'tenant' }, 'tenant-1'),
    ).toBe('decisions:tenant-1');
    expect(limiterKey({ name: 'gemini', per: 'global' }, 'tenant-1')).toBe(
      'gemini',
    );
  });
});

describe('createRegistry', () => {
  test('get, list and describe: steps and shapes, no code', () => {
    const scoring = toyScoring().job;
    const stopping = toyStopping().job;
    const registry = createRegistry([scoring, stopping]);
    expect(registry.get('toy.scoring')).toBe(scoring);
    expect(registry.has('toy.nope')).toBe(false);
    expect(registry.list().map((j) => j.key)).toEqual([
      'toy.scoring',
      'toy.stopping',
    ]);
    const described = registry.describe('toy.scoring');
    expect(described).toMatchObject({
      key: 'toy.scoring',
      version: scoring.version,
      steps: [
        { name: 'list', kind: 'step' },
        {
          name: 'score',
          kind: 'map',
          batchMax: 2,
          limiters: [{ name: 'toy', per: 'global' }],
        },
        { name: 'summary', kind: 'step' },
      ],
      input: { type: 'object', required: ['n'] },
    });
    expect(JSON.stringify(described)).not.toContain('=>');
  });

  test('an unknown key and two jobs with one key are definition errors', () => {
    const registry = createRegistry([toyScoring().job]);
    expect(() => registry.get('toy.nope')).toThrow(JobDefinitionError);
    expect(() => createRegistry([toyScoring().job, toyScoring().job])).toThrow(
      'two jobs are keyed toy.scoring',
    );
  });
});

describe('definitionVersion', () => {
  test('stable for the same definition, different when a fact changes', () => {
    const a = calibration().version;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(calibration().version).toBe(a);
    expect(calibration(3).version).not.toBe(a);
    expect(toyScoring().job.version).toBe(toyScoring().job.version);
    expect(toyScoring({ batchMax: 5 }).job.version).not.toBe(
      toyScoring().job.version,
    );
    expect(toyStopping().job.version).not.toBe(toyScoring().job.version);
  });

  test('a shape with a part JSON Schema cannot express still versions by the rest of it', () => {
    const withInput = (input: z.ZodType<{ n: number }>) =>
      defineJob({
        key: 'toy.opaque',
        input,
        output: z.number(),
        steps: (s) => s.add('n', step({ run: ({ input: i }) => i.n })),
      }).version;
    const at = z.date();
    const a = z.object({ n: z.number(), at });
    const b = z.object({ n: z.number(), at, note: z.string() });
    const c = z.object({ n: z.number().int(), at });
    expect(withInput(a)).toBe(withInput(a));
    expect(withInput(b)).not.toBe(withInput(a));
    expect(withInput(c)).not.toBe(withInput(a));
  });

  test("a map step's result schema is part of the version", () => {
    const withResult = (result: z.ZodType<number>) =>
      defineJob({
        key: 'toy.result',
        input: Input,
        output: z.number(),
        steps: (s) =>
          s
            .add(
              'judge',
              mapStep({
                items: () => ['a'],
                key: (r) => r,
                run: async (batch) => batch.map(() => 0),
                result,
                batch: { max: 1 },
                limiter: 'toy',
              }),
            )
            .add('n', step({ run: ({ judge }) => judge.results.length })),
      }).version;
    expect(withResult(z.number())).toBe(withResult(z.number()));
    expect(withResult(z.number().max(0))).not.toBe(withResult(z.number()));
  });

  test("a map step's present never enters the version: it is presentation", () => {
    const withPresent = (present: 'none' | 'a' | 'b') =>
      defineJob({
        key: 'toy.present-version',
        input: Input,
        output: z.number(),
        steps: (s) =>
          s
            .add(
              'judge',
              mapStep({
                items: () => ['a'],
                key: (r) => r,
                run: async (batch) => batch.map(() => 0),
                result: z.number(),
                batch: { max: 1 },
                limiter: 'toy',
                ...(present === 'none'
                  ? {}
                  : {
                      present:
                        present === 'a'
                          ? ({ key }: { key: string }) => ({ label: key })
                          : ({ result }: { result: number | null }) => ({
                              label: String(result),
                            }),
                    }),
              }),
            )
            .add('n', step({ run: ({ judge }) => judge.results.length })),
      }).version;
    expect(withPresent('a')).toBe(withPresent('none'));
    expect(withPresent('b')).toBe(withPresent('none'));
  });

  test("a plain step's present never enters the version: it is presentation", () => {
    const withPresent = (present: 'none' | 'a' | 'b') =>
      defineJob({
        key: 'toy.step-present-version',
        input: Input,
        output: z.number(),
        steps: (s) =>
          s.add(
            'n',
            step({
              run: () => 1,
              ...(present === 'none'
                ? {}
                : {
                    present:
                      present === 'a'
                        ? () => ({ summary: 'one' })
                        : ({ output }: { output: number | null }) => ({
                            summary: String(output),
                          }),
                  }),
            }),
          ),
      }).version;
    expect(withPresent('a')).toBe(withPresent('none'));
    expect(withPresent('b')).toBe(withPresent('none'));
  });

  test("a map step's stopWhen enters the version by its presence only; its key, a function, enters nothing", () => {
    const withStop = (stop: 'none' | 'a' | 'b', key: 'a' | 'b' = 'a') =>
      defineJob({
        key: 'toy.stop-version',
        input: Input,
        output: z.number(),
        steps: (s) =>
          s
            .add(
              'judge',
              mapStep({
                items: () => ['a'],
                key: key === 'a' ? (r) => r : (r) => `${r}`,
                run: async (batch) => batch.map(() => 0),
                batch: { max: 1 },
                limiter: 'toy',
                ...(stop === 'none'
                  ? {}
                  : {
                      stopWhen:
                        stop === 'a'
                          ? (o: { ok: boolean }) => o.ok
                          : (o: { ok: boolean }) => !o.ok,
                    }),
              }),
            )
            .add('n', step({ run: ({ judge }) => judge.results.length })),
      }).version;
    const none = withStop('none');
    // Declaring a stop changes the version: a run planned to completion must not resume as one that stops early.
    expect(withStop('a')).not.toBe(none);
    // Its code is not structure: a new rule is declared by bumping `version`.
    expect(withStop('b')).toBe(withStop('a'));
    // A key is code too: what it means is versioned by the key strings themselves.
    expect(withStop('none', 'b')).toBe(none);
  });

  test('structural: a change to a function body alone keeps the version; a version bump, a schema, a step or a fact changes it', () => {
    const job = (
      over: {
        version?: number;
        body?: 'a' | 'b';
        input?: z.ZodType<{ n: number }>;
        extraStep?: boolean;
        name?: 'line' | 'place';
        limiter?: string;
        retries?: number;
        gate?: string;
      } = {},
    ) => {
      const body = over.body ?? 'a';
      return defineJob({
        key: 'toy.structure',
        version: over.version,
        input: over.input ?? Input,
        output: z.number(),
        steps: (s) => {
          const chain = s
            .add(
              'band',
              // The same step with another body: the text a script's TypeScript and a worker's dist both differ by.
              step({
                run:
                  body === 'a'
                    ? ({ input }) => [String(input.n)]
                    : ({ input }) => {
                        const n = input.n;
                        return [`${n}`];
                      },
                gates: over.gate
                  ? [gate({ name: over.gate, isOpen: () => true })]
                  : undefined,
                retry: over.retries
                  ? {
                      initialIntervalMs: 1,
                      backoffCoefficient: 1,
                      maximumAttempts: over.retries,
                    }
                  : undefined,
              }),
            )
            .add(
              'judge',
              mapStep({
                items: ({ band }) => band,
                key: (ref) => (body === 'a' ? ref : `${ref}`),
                run: async (batch) => batch.map(() => 1),
                result: z.number(),
                batch: { max: 2 },
                limiter: over.limiter ?? 'toy',
              }),
            );
          const named = chain.add(
            over.name ?? 'line',
            step({ run: ({ judge }) => judge.results.length }),
          );
          return over.extraStep
            ? named.add('extra', step({ run: () => 2 }))
            : named;
        },
      }).version;
    };
    const base = job();
    expect(job({ body: 'b' })).toBe(base);
    expect(job({ version: 1 })).toBe(base);
    // Limiters and gates change when work runs, never what it computes: they leave the hash.
    expect(job({ limiter: 'other' })).toBe(base);
    expect(job({ gate: 'ai-processing' })).toBe(base);
    expect(job({ gate: 'other' })).toBe(base);
    for (const changed of [
      job({ version: 2 }),
      job({ input: z.object({ n: z.number().int() }) }),
      job({ extraStep: true }),
      job({ name: 'place' }),
      job({ retries: 5 }),
    ])
      expect(changed).not.toBe(base);
  });

  test('a version is a positive integer', () => {
    for (const version of [0, -1, 1.5])
      expect(() =>
        defineJob({
          key: 'toy.bad-version',
          version,
          input: Input,
          output: z.number(),
          steps: (s) => s.add('a', step({ run: () => 1 })),
        }),
      ).toThrow(JobDefinitionError);
  });
});

describe('job facts', () => {
  const LIMITS = {
    maxItems: 100,
    maxUsd: 1,
    maxCalls: 10,
    maxDurationMs: 60_000,
  };
  const facts = (
    over: Partial<
      Pick<
        Parameters<typeof defineJob<{ n: number }, number, unknown>>[0],
        'audience' | 'authority' | 'limits'
      >
    > = {},
    effect: 'idempotent' | 'side-effect' = 'idempotent',
  ) =>
    defineJob({
      key: 'toy.facts',
      input: Input,
      output: z.number(),
      steps: (s) =>
        s.add('only', step({ run: ({ input }) => input.n, effect })),
      ...over,
    });

  test('the defaults: internal, read by a member, started by an admin, no limits, no admit', () => {
    const job = facts();
    expect(job.audience).toBe('internal');
    expect(job.authority).toEqual({
      read: 'member',
      dryRun: 'admin',
      start: 'admin',
    });
    expect(job.limits).toBeUndefined();
    expect(job.admit).toBeUndefined();
    expect(facts({ authority: { start: 'tenant-wide' } }).authority.dryRun).toBe(
      'tenant-wide',
    );
  });

  test('a public job without limits, or with a limit that is not a positive finite number (a whole one where it counts), is refused', () => {
    expect(() => facts({ audience: 'public' })).toThrow(JobDefinitionError);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() =>
        facts({ audience: 'public', limits: { ...LIMITS, maxUsd: bad } }),
      ).toThrow('limits.maxUsd');
    for (const name of ['maxItems', 'maxCalls', 'maxDurationMs'] as const)
      expect(() =>
        facts({ audience: 'public', limits: { ...LIMITS, [name]: 1.5 } }),
      ).toThrow(`limits.${name} must be a whole number`);
    expect(
      facts({ audience: 'public', limits: { ...LIMITS, maxUsd: 0.25 } }).limits
        ?.maxUsd,
    ).toBe(0.25);
    expect(facts({ audience: 'public', limits: LIMITS }).limits).toEqual(
      LIMITS,
    );
  });

  test('read above dryRun, or dryRun above start, is refused', () => {
    expect(() =>
      facts({ authority: { read: 'admin', dryRun: 'tenant-wide' } }),
    ).toThrow('authority.read');
    expect(() =>
      facts({ authority: { dryRun: 'admin', start: 'tenant-wide' } }),
    ).toThrow('authority.dryRun');
  });

  test('a side-effect job may open its dry run to tenant-wide, never its real run', () => {
    expect(
      facts({ authority: { dryRun: 'tenant-wide' } }, 'side-effect').authority,
    ).toEqual({ read: 'member', dryRun: 'tenant-wide', start: 'admin' });
    expect(() =>
      facts({ authority: { start: 'tenant-wide' } }, 'side-effect'),
    ).toThrow('side effect');
    expect(facts({}, 'side-effect').authority.start).toBe('admin');
    expect(
      facts({ authority: { read: 'tenant-wide', dryRun: 'tenant-wide' } }).authority,
    ).toEqual({ read: 'tenant-wide', dryRun: 'tenant-wide', start: 'admin' });
  });

  test('the facts are not part of the version', () => {
    const base = facts().version;
    expect(
      facts({
        audience: 'public',
        limits: LIMITS,
        authority: { read: 'tenant-wide', start: 'tenant-wide' },
      }).version,
    ).toBe(base);
  });

  test('describe carries the facts', () => {
    const job = facts({
      audience: 'public',
      limits: LIMITS,
      authority: { read: 'tenant-wide', dryRun: 'tenant-wide' },
    });
    expect(createRegistry([job]).describe(job.key)).toMatchObject({
      audience: 'public',
      authority: { read: 'tenant-wide', dryRun: 'tenant-wide', start: 'admin' },
      limits: LIMITS,
    });
  });
});
