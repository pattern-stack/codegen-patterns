/**
 * FieldDiffSchema unit tests (SYNC-2)
 *
 * The Zod schema is the structural enforcement of `integration_run_items.changed_fields`
 * per ADR-0003 (dealbrain-v2). These tests document the shape the recorder
 * service will enforce at write time.
 */
import { describe, expect, it } from 'bun:test';
import {
  FieldDiffSchema,
  FieldDiffValueSchema,
} from '../../../../runtime/subsystems/integration/integration-field-diff.protocol';

describe('FieldDiffValueSchema', () => {
  it('accepts a minimal { from, to } pair', () => {
    const parsed = FieldDiffValueSchema.parse({ from: 'a', to: 'b' });
    expect(parsed).toEqual({ from: 'a', to: 'b' });
  });

  it('accepts nulls on either side (created / deleted shapes)', () => {
    expect(FieldDiffValueSchema.parse({ from: null, to: 42 })).toEqual({
      from: null,
      to: 42,
    });
    expect(FieldDiffValueSchema.parse({ from: 42, to: null })).toEqual({
      from: 42,
      to: null,
    });
  });

  it('accepts heterogeneous unknowns (numbers, strings, nested objects)', () => {
    expect(
      FieldDiffValueSchema.parse({
        from: { nested: { deep: true } },
        to: ['array', 1, null],
      }),
    ).toBeDefined();
  });

  it('accepts `undefined` for `from` or `to` (z.unknown tolerates omitted keys)', () => {
    // Documents the relaxation: since `from`/`to` are `z.unknown()`, an
    // object with the key absent passes because `undefined` is a valid
    // `unknown`. Writers in dealbrain-v2 always set both keys explicitly;
    // the recorder relies on convention, not schema enforcement here.
    expect(FieldDiffValueSchema.safeParse({ to: 'b' }).success).toBe(true);
    expect(FieldDiffValueSchema.safeParse({ from: 'a' }).success).toBe(true);
  });

  it('rejects a non-object value', () => {
    expect(FieldDiffValueSchema.safeParse('not-an-object').success).toBe(false);
    expect(FieldDiffValueSchema.safeParse(42).success).toBe(false);
    expect(FieldDiffValueSchema.safeParse(null).success).toBe(false);
  });
});

describe('FieldDiffSchema', () => {
  it('accepts an empty diff (no-op shape)', () => {
    expect(FieldDiffSchema.parse({})).toEqual({});
  });

  it('accepts the canonical ADR-0003 example (amount + stage_name)', () => {
    const parsed = FieldDiffSchema.parse({
      stage_name: { from: 'Prospecting', to: 'Closed Won' },
      amount: { from: 92364, to: 120000 },
    });
    expect(parsed['stage_name']).toEqual({
      from: 'Prospecting',
      to: 'Closed Won',
    });
    expect(parsed['amount']).toEqual({ from: 92364, to: 120000 });
  });

  it('accepts the created shape (every field from=null)', () => {
    const parsed = FieldDiffSchema.parse({
      name: { from: null, to: 'Acme' },
      amount: { from: null, to: 5000 },
    });
    expect(parsed).toBeDefined();
  });

  it('accepts the deleted shape (every field to=null)', () => {
    const parsed = FieldDiffSchema.parse({
      name: { from: 'Acme', to: null },
      amount: { from: 5000, to: null },
    });
    expect(parsed).toBeDefined();
  });

  it('rejects a diff whose value is not a { from, to } pair', () => {
    const result = FieldDiffSchema.safeParse({
      stage_name: 'Prospecting → Closed Won',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a diff whose value is a primitive', () => {
    const result = FieldDiffSchema.safeParse({ amount: 42 });
    expect(result.success).toBe(false);
  });
});
