import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createRegistry, defineJob, mapStep, step } from '../../index.ts';
import { limitersUnconfigured } from '../limiters.ts';

describe('limitersUnconfigured', () => {
  const job = defineJob({
    key: 'toy.limited',
    input: z.object({}),
    output: z.number(),
    steps: (s) =>
      s
        .add(
          'band',
          step({
            run: () => ['a'],
            limiter: { name: 'bands', per: 'tenant' },
          }),
        )
        .add(
          'judge',
          mapStep({
            items: ({ band }) => band,
            key: (r) => r,
            run: async (batch) => batch.map(() => 1),
            batch: { max: 1 },
            limiter: ['gemini', { name: 'decisions', per: 'tenant' }],
          }),
        )
        .add('n', step({ run: ({ judge }) => judge.results.length })),
  });
  const registry = createRegistry([job]);

  it('names each limiter a registered step draws on without a config', () => {
    expect(limitersUnconfigured(registry, { bands: { inFlight: 2 } })).toEqual([
      'toy.limited/judge: decisions',
      'toy.limited/judge: gemini',
    ]);
  });

  it('is empty once every name has a config', () => {
    expect(
      limitersUnconfigured(registry, {
        bands: { inFlight: 2 },
        decisions: { inFlight: 6 },
        gemini: { inFlight: 40, callsPerMinute: 600 },
      }),
    ).toEqual([]);
  });
});
