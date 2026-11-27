import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineShape, snakeCaseOf } from '../define-shape.ts';

const pointer = z.object({
  observationId: z.string().describe('The newest observation.'),
  day: z.string(),
});

const row = defineShape(
  z
    .object({
      accountId: z.string().uuid().describe('The account.'),
      lastBuyerTouchAt: z.string().nullable(),
      matchedIndicators: z
        .array(
          z
            .object({ indicatorId: z.string(), latest: pointer })
            .describe('Each.'),
        )
        .max(3),
      typeMix: z.record(z.string(), z.number().int()),
      structuredData: z.record(z.string(), z.unknown()).optional(),
      evidenceCount: z.number().int().min(0).max(5).default(0),
    })
    .strict()
    .describe('A row.'),
);

describe('defineShape', () => {
  it('names each field in snake_case, mechanically', () => {
    expect(snakeCaseOf('lastBuyerTouchAt')).toBe('last_buyer_touch_at');
    expect(snakeCaseOf('id')).toBe('id');
    expect(snakeCaseOf('last30Days')).toBe('last30_days');
    expect(Object.keys(row.public.shape)).toEqual([
      'account_id',
      'last_buyer_touch_at',
      'matched_indicators',
      'type_mix',
      'structured_data',
      'evidence_count',
    ]);
    const item = row.public.shape.matched_indicators.element;
    expect(Object.keys(item.shape)).toEqual(['indicator_id', 'latest']);
    expect(Object.keys(item.shape.latest.shape)).toEqual([
      'observation_id',
      'day',
    ]);
  });

  it('keeps every description, bound, wrapper and the strictness', () => {
    const publicRow = row.public;
    expect(publicRow.description).toBe('A row.');
    expect(publicRow.shape.account_id.description).toBe('The account.');
    expect(publicRow.shape.matched_indicators.element.description).toBe(
      'Each.',
    );
    expect(
      publicRow.shape.matched_indicators.element.shape.latest.shape
        .observation_id.description,
    ).toBe('The newest observation.');
    expect(publicRow.safeParse({ ...validPublic(), extra: 1 }).success).toBe(
      false,
    );
    expect(
      publicRow.safeParse({ ...validPublic(), account_id: 'nope' }).success,
    ).toBe(false);
    expect(
      publicRow.safeParse({
        ...validPublic(),
        matched_indicators: Array.from({ length: 4 }, () => indicator()),
      }).success,
    ).toBe(false);
    expect(publicRow.parse(validPublic()).evidence_count).toBe(0);
    expect(publicRow.shape.structured_data.isOptional()).toBe(true);
    expect(publicRow.shape.last_buyer_touch_at.isNullable()).toBe(true);
  });

  it('converts a value both ways, keeping a record’s own keys', () => {
    const value = {
      accountId: '9a3d6a4e-2d33-4a52-9a9e-3b6e2c1f5a10',
      lastBuyerTouchAt: null,
      matchedIndicators: [
        {
          indicatorId: 's1',
          latest: { observationId: 'o1', day: '2026-10-01' },
        },
      ],
      typeMix: { buying_intent: 2, painPoint: 1 },
      structuredData: { askerSide: 'buyer' },
      evidenceCount: 2,
    };
    const publicValue = row.toPublic(value);
    expect(publicValue).toEqual({
      account_id: value.accountId,
      last_buyer_touch_at: null,
      matched_indicators: [
        {
          indicator_id: 's1',
          latest: { observation_id: 'o1', day: '2026-10-01' },
        },
      ],
      type_mix: { buying_intent: 2, painPoint: 1 },
      structured_data: { askerSide: 'buyer' },
      evidence_count: 2,
    });
    expect(row.fromPublic(publicValue)).toEqual(value);
  });

  it('keeps the value’s field order and leaves an absent field absent', () => {
    const publicValue = row.toPublic({
      evidenceCount: 1,
      accountId: 'a',
      lastBuyerTouchAt: 'x',
      matchedIndicators: [],
      typeMix: {},
    });
    expect(JSON.stringify(publicValue)).toBe(
      '{"evidence_count":1,"account_id":"a","last_buyer_touch_at":"x","matched_indicators":[],"type_mix":{}}',
    );
  });

  it('drops a field the shape does not name, as zod strips it', () => {
    const shape = defineShape(z.object({ indicatorId: z.string() }));
    const withExtra = { indicatorId: 's', versionId: 'v' } as {
      indicatorId: string;
    };
    expect(shape.toPublic(withExtra)).toEqual({ indicator_id: 's' });
  });

  it('never changes the schema it was given', () => {
    const base = z.object({ dealId: z.string() });
    const shape = defineShape(base);
    expect('public' in base).toBe(false);
    expect(Object.keys(shape.public.shape)).toEqual(['deal_id']);
    expect(Object.keys(base.shape)).toEqual(['dealId']);
  });

  it('composes by defining the composed schema again', () => {
    const base = defineShape(z.object({ dealId: z.string() }));
    const extended = defineShape(base.extend({ isClosed: z.boolean() }));
    expect(Object.keys(extended.public.shape)).toEqual([
      'deal_id',
      'is_closed',
    ]);
  });

  it('refuses a field name that is not camelCase', () => {
    expect(() => defineShape(z.object({ deal_id: z.string() }))).toThrow(
      'not a camelCase field name',
    );
  });

  it('refuses an object it cannot follow', () => {
    expect(() =>
      defineShape(
        z.object({
          subject: z.union([
            z.object({ accountId: z.string() }),
            z.object({ dealId: z.string() }),
          ]),
        }),
      ),
    ).toThrow('cannot be converted');
    expect(() =>
      defineShape(
        z.object({
          window: z
            .object({ dateFrom: z.string() })
            .refine(() => true, 'never'),
        }),
      ),
    ).toThrow('cannot be converted');
  });
});

function indicator() {
  return { indicator_id: 's', latest: { observation_id: 'o', day: 'd' } };
}

function validPublic() {
  return {
    account_id: '9a3d6a4e-2d33-4a52-9a9e-3b6e2c1f5a10',
    last_buyer_touch_at: null,
    matched_indicators: [indicator()],
    type_mix: {},
  };
}
