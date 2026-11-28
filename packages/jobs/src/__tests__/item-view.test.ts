import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type ItemViewInput,
  itemViewSchema,
  stepViewSchema,
} from '../define/item-view.ts';
import { mapStep } from '../define/map-step.ts';
import { step } from '../define/step.ts';

describe('itemViewSchema', () => {
  test('a label alone, or with a summary and detail sections, reads', () => {
    expect(itemViewSchema.safeParse({ label: 'GTCR · email' }).success).toBe(
      true,
    );
    expect(
      itemViewSchema.safeParse({
        label: 'GTCR · email',
        summary: '→ netsuite, sap_concur',
        detail: [
          { heading: 'netsuite', text: 'picked', quote: 'We use NetSuite' },
        ],
      }).success,
    ).toBe(true);
  });

  test('an empty label, an over-long field or too many sections is refused', () => {
    expect(itemViewSchema.safeParse({ label: '' }).success).toBe(false);
    expect(itemViewSchema.safeParse({ label: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(
      itemViewSchema.safeParse({ label: 'a', summary: 'x'.repeat(501) })
        .success,
    ).toBe(false);
    expect(
      itemViewSchema.safeParse({
        label: 'a',
        detail: Array.from({ length: 101 }, () => ({ heading: 'h' })),
      }).success,
    ).toBe(false);
  });
});

describe('mapStep present', () => {
  const step = (
    present?: (i: ItemViewInput<{ name: string }>) => {
      label: string;
    },
  ) =>
    mapStep({
      items: () => ['a'],
      key: (r) => r,
      run: async (batch) => batch.map((b) => ({ name: b.ref })),
      result: z.object({ name: z.string() }),
      batch: { max: 1 },
      limiter: 'toy',
      present,
    });

  test('the erased step carries the presenter, called with the item as stored', () => {
    const erased = step(({ key, result, status }) => ({
      label: `${result?.name ?? key} · ${status}`,
    })).erased;
    if (erased.kind !== 'map') throw new Error('a map step');
    expect(
      erased.present?.({
        ref: 'r1',
        key: 'k1',
        status: 'done',
        result: { name: 'GTCR' },
        error: null,
      }),
    ).toEqual({ label: 'GTCR · done' });
  });

  test('a step with no presenter carries none', () => {
    const erased = step().erased;
    if (erased.kind !== 'map') throw new Error('a map step');
    expect(erased.present).toBeUndefined();
  });
});

describe('stepViewSchema', () => {
  test('a summary alone, or with a label and detail sections, reads', () => {
    expect(
      stepViewSchema.safeParse({ summary: '88 to ask of 88' }).success,
    ).toBe(true);
    expect(
      stepViewSchema.safeParse({
        label: 'count',
        summary: '88 to ask of 88 in the Signal · est. $0.09',
        detail: [{ heading: 'judge', text: 'gemini · low' }],
      }).success,
    ).toBe(true);
  });

  test('no summary, an empty or over-long field, or too many sections is refused', () => {
    expect(stepViewSchema.safeParse({}).success).toBe(false);
    expect(stepViewSchema.safeParse({ summary: '' }).success).toBe(false);
    expect(stepViewSchema.safeParse({ summary: 'x'.repeat(301) }).success).toBe(
      false,
    );
    expect(stepViewSchema.safeParse({ summary: 'a', label: '' }).success).toBe(
      false,
    );
    expect(
      stepViewSchema.safeParse({ summary: 'a', label: 'x'.repeat(201) })
        .success,
    ).toBe(false);
    expect(
      stepViewSchema.safeParse({
        summary: 'a',
        detail: [{ heading: 'h', text: 'x'.repeat(2001) }],
      }).success,
    ).toBe(false);
    expect(
      stepViewSchema.safeParse({
        summary: 'a',
        detail: Array.from({ length: 101 }, () => ({ heading: 'h' })),
      }).success,
    ).toBe(false);
  });
});

describe('step present', () => {
  test('the erased step carries the presenter, called with the step as stored', () => {
    const erased = step({
      run: () => ({ toAsk: 88, planned: 88 }),
      present: ({ output, status }) =>
        output && {
          summary: `${output.toAsk} of ${output.planned} · ${status}`,
        },
    }).erased;
    if (erased.kind !== 'step') throw new Error('a plain step');
    expect(
      erased.present?.({
        output: { toAsk: 3, planned: 5 },
        status: 'completed',
        error: null,
      }),
    ).toEqual({ summary: '3 of 5 · completed' });
    expect(
      erased.present?.({ output: null, status: 'pending', error: null }),
    ).toBeNull();
  });

  test('a step with no presenter carries none', () => {
    const erased = step({ run: () => 1 }).erased;
    if (erased.kind !== 'step') throw new Error('a plain step');
    expect(erased.present).toBeUndefined();
  });
});
