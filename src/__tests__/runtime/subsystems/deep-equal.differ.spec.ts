/**
 * Unit tests for DeepEqualDiffer (SYNC-5).
 *
 * Exercises the five design calls documented in `deep-equal.differ.ts`:
 *   1. Ignore list for row metadata
 *   2. providerChangedFields (CDC) hint
 *   3. Date → toISOString normalization
 *   4. Decimal-string vs number normalization
 *   5. null-existing → created-shape diff
 *
 * Plus cleared-field (key on existing, null on incoming) coverage and
 * nested object equality.
 *
 * #488 Test 2b — diff-soundness (behavioral, reviewer-required):
 *   Asserts the contract the sink emitter's bare-passthrough null-preservation
 *   rule protects. A null-yielding adapter record and a null-preserving find()
 *   view (produced by bare passthrough) must diff to 'noop' — if the generator
 *   emitted `?? ''` instead, `isEqual(null, '')` → false → spurious upsert that
 *   never converges. Cites deep-equal.differ.ts:187-208 / :220.
 */
import { describe, it, expect } from 'bun:test';
import { DeepEqualDiffer } from '../../../../runtime/subsystems/integration/deep-equal.differ';

type Rec = Record<string, unknown>;

describe('DeepEqualDiffer', () => {
  describe('null existing → created-shape diff', () => {
    it('emits {from: null, to: <value>} for every non-null field', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(null, { amount: 100, stageName: 'Prospecting' });
      expect(result).toEqual({
        amount: { from: null, to: 100 },
        stageName: { from: null, to: 'Prospecting' },
      });
    });

    it('skips null/undefined fields on a created record', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(null, { amount: 100, closedAt: null, stageName: undefined });
      expect(result).toEqual({ amount: { from: null, to: 100 } });
    });

    it('returns noop when the incoming record has no non-null user fields', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(null, { id: 'x', createdAt: new Date() });
      expect(result).toBe('noop');
    });
  });

  describe('ignore list', () => {
    it('ignores default row-metadata fields', () => {
      const d = new DeepEqualDiffer<Rec>();
      const now = new Date();
      const later = new Date(now.getTime() + 10_000);
      const result = d.diff(
        { id: 'a', createdAt: now, updatedAt: now, deletedAt: null, amount: 100 },
        { id: 'a', createdAt: now, updatedAt: later, deletedAt: null, amount: 100 },
      );
      expect(result).toBe('noop');
    });

    it('ignores providerMetadata, type, lastModifiedAt, fields', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(
        {
          type: 'opp',
          lastModifiedAt: '2026-01-01',
          providerMetadata: { x: 1 },
          fields: { customA: 'v1' },
          amount: 100,
        },
        {
          type: 'opportunity',
          lastModifiedAt: '2026-04-20',
          providerMetadata: { x: 2 },
          fields: { customA: 'v2' },
          amount: 100,
        },
      );
      expect(result).toBe('noop');
    });

    it('augments the ignore list via options.ignore', () => {
      const d = new DeepEqualDiffer<Rec>({ ignore: ['integration_version'] });
      const result = d.diff(
        { amount: 100, integration_version: 1 },
        { amount: 100, integration_version: 2 },
      );
      expect(result).toBe('noop');
    });

    it('still diffs non-ignored fields alongside ignored ones', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(
        { id: 'a', amount: 100 },
        { id: 'a', amount: 120 },
      );
      expect(result).toEqual({ amount: { from: 100, to: 120 } });
    });
  });

  // DIFFER-UNIGNORE (0.17.1) — the inverse knob: REMOVE a default-ignored field
  // so it registers as a domain change. Regression coverage for the swe-brain
  // ADR-0009 Amendment B §B4 drain: a `message` entity with `softDelete: false`
  // carries the retraction tombstone on `deletedAt`; without un-ignoring it the
  // delete diffs to 'noop', the upsert is skipped, and `deleted_at` never lands.
  describe('unignore knob', () => {
    it('by DEFAULT, a deletedAt-only change diffs to noop (the bug)', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(
        { id: 'a', amount: 100, deletedAt: null },
        { id: 'a', amount: 100, deletedAt: '2026-06-04T00:00:00.000Z' },
      );
      expect(result).toBe('noop');
    });

    it('un-ignored deletedAt produces a field diff (the tombstone lands)', () => {
      const d = new DeepEqualDiffer<Rec>({ unignore: ['deletedAt'] });
      const result = d.diff(
        { id: 'a', amount: 100, deletedAt: null },
        { id: 'a', amount: 100, deletedAt: '2026-06-04T00:00:00.000Z' },
      );
      expect(result).toEqual({
        deletedAt: { from: null, to: '2026-06-04T00:00:00.000Z' },
      });
    });

    it('un-ignored deletedAt is created-shape on null existing', () => {
      // The orchestrator turns a non-noop diff into 'created'/'updated' — here
      // the un-ignored tombstone field is part of the created shape.
      const d = new DeepEqualDiffer<Rec>({ unignore: ['deletedAt'] });
      const result = d.diff(null, {
        id: 'a',
        amount: 100,
        deletedAt: '2026-06-04T00:00:00.000Z',
      });
      expect(result).toEqual({
        amount: { from: null, to: 100 },
        deletedAt: { from: null, to: '2026-06-04T00:00:00.000Z' },
      });
    });

    it('un-ignoring a field NOT in the ignore set is a harmless no-op', () => {
      const d = new DeepEqualDiffer<Rec>({ unignore: ['amount'] });
      const result = d.diff({ amount: 100 }, { amount: 120 });
      expect(result).toEqual({ amount: { from: 100, to: 120 } });
    });

    it('unignore wins over a field also listed in ignore', () => {
      const d = new DeepEqualDiffer<Rec>({
        ignore: ['deletedAt'],
        unignore: ['deletedAt'],
      });
      const result = d.diff(
        { deletedAt: null },
        { deletedAt: '2026-06-04T00:00:00.000Z' },
      );
      expect(result).toEqual({
        deletedAt: { from: null, to: '2026-06-04T00:00:00.000Z' },
      });
    });

    it('un-ignoring deletedAt does NOT leak to a separate default differ', () => {
      // Per-instance isolation — DEFAULT_IGNORE_FIELDS is never mutated.
      const unignored = new DeepEqualDiffer<Rec>({ unignore: ['deletedAt'] });
      const plain = new DeepEqualDiffer<Rec>();
      const args: [Rec, Rec] = [
        { deletedAt: null },
        { deletedAt: '2026-06-04T00:00:00.000Z' },
      ];
      expect(unignored.diff(...args)).not.toBe('noop');
      expect(plain.diff(...args)).toBe('noop');
    });
  });

  describe('providerChangedFields hint (CDC)', () => {
    it('restricts comparison to the hinted field set', () => {
      const d = new DeepEqualDiffer<Rec>();
      // Both `amount` and `stageName` differ, but only `amount` is hinted.
      const result = d.diff(
        { amount: 100, stageName: 'Prospecting' },
        { amount: 120, stageName: 'Closed Won' },
        ['amount'],
      );
      expect(result).toEqual({ amount: { from: 100, to: 120 } });
    });

    it('ignore list wins over hint', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(
        { updatedAt: new Date('2026-01-01'), amount: 100 },
        { updatedAt: new Date('2026-04-20'), amount: 100 },
        ['updatedAt'],
      );
      expect(result).toBe('noop');
    });

    it('empty hint array falls back to full-field diff', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(
        { amount: 100, stageName: 'Prospecting' },
        { amount: 120, stageName: 'Closed Won' },
        [],
      );
      expect(result).toEqual({
        amount: { from: 100, to: 120 },
        stageName: { from: 'Prospecting', to: 'Closed Won' },
      });
    });
  });

  describe('Date normalization', () => {
    it('treats Date === equivalent-ISO-string Date as equal', () => {
      const d = new DeepEqualDiffer<Rec>();
      const ts = '2026-04-21T13:00:00.000Z';
      const result = d.diff(
        { closedAt: new Date(ts) },
        { closedAt: new Date(ts) },
      );
      expect(result).toBe('noop');
    });

    it('treats Date === same ISO string as equal (mixed shapes)', () => {
      const d = new DeepEqualDiffer<Rec>();
      const ts = '2026-04-21T13:00:00.000Z';
      const result = d.diff(
        { closedAt: new Date(ts) },
        { closedAt: ts },
      );
      expect(result).toBe('noop');
    });

    it('flags genuinely different timestamps', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(
        { closedAt: new Date('2026-04-20T13:00:00.000Z') },
        { closedAt: new Date('2026-04-21T13:00:00.000Z') },
      );
      expect(result).toEqual({
        closedAt: {
          from: new Date('2026-04-20T13:00:00.000Z'),
          to: new Date('2026-04-21T13:00:00.000Z'),
        },
      });
    });
  });

  describe('decimal-string vs number normalization', () => {
    it('treats "100" === 100 as equal (Postgres numeric → string)', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff({ amount: '100' }, { amount: 100 });
      expect(result).toBe('noop');
    });

    it('treats 100 === "100" as equal (symmetric)', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff({ amount: 100 }, { amount: '100' });
      expect(result).toBe('noop');
    });

    it('does not coerce non-numeric strings', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff({ label: 'hello' }, { label: 100 });
      expect(result).toEqual({ label: { from: 'hello', to: 100 } });
    });

    it('distinguishes zero from empty string', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff({ amount: '' }, { amount: 0 });
      // '' does not pass isFinite(Number('')) === 0 guard — we explicitly
      // reject empty strings so they don't silently equal 0.
      expect(result).toEqual({ amount: { from: '', to: 0 } });
    });

    it('handles decimal precision: "100.00" === 100', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff({ amount: '100.00' }, { amount: 100 });
      expect(result).toBe('noop');
    });
  });

  describe('cleared-field detection', () => {
    it('detects a field transitioning to null', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(
        { stageName: 'Prospecting' },
        { stageName: null },
      );
      expect(result).toEqual({
        stageName: { from: 'Prospecting', to: null },
      });
    });
  });

  describe('nested object equality', () => {
    it('treats deep-equal nested objects as equal', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(
        { addr: { street: '1 Main', city: 'NYC' } },
        { addr: { street: '1 Main', city: 'NYC' } },
      );
      expect(result).toBe('noop');
    });

    it('flags deep-inequal nested objects', () => {
      const d = new DeepEqualDiffer<Rec>();
      const result = d.diff(
        { addr: { street: '1 Main', city: 'NYC' } },
        { addr: { street: '2 Main', city: 'NYC' } },
      );
      expect(result).toEqual({
        addr: {
          from: { street: '1 Main', city: 'NYC' },
          to: { street: '2 Main', city: 'NYC' },
        },
      });
    });
  });

  describe('returns noop when all comparisons equal', () => {
    it('round-trip through an unchanged record', () => {
      const d = new DeepEqualDiffer<Rec>();
      const rec = { amount: 100, stageName: 'Prospecting' };
      const result = d.diff(rec, { ...rec });
      expect(result).toBe('noop');
    });
  });

  // ============================================================================
  // #488 Test 2b — diff-soundness: null-preserving find() output yields noop
  //
  // The sink emitter emits BARE passthrough (`text: row.text,` with no `?? ''`)
  // so that null is preserved exactly. This test asserts the contract that bare
  // passthrough protects — independent of the emitted string:
  //   (a) null-preserving find() view diffs equal against a null-yielding adapter
  //       record → 'noop' (the cycle converges; no spurious upsert).
  //   (b) `'' !== null` under the differ — proving that a blanket `?? ''` coercion
  //       WOULD have broken convergence (the exact bug the generator avoids).
  // Citations: deep-equal.differ.ts:187-208, :34-35 ("preserves zero-vs-null
  // distinction"), :220 (empty-string guard).
  // ============================================================================

  describe('#488 Test 2b — diff-soundness: null-preserving passthrough', () => {
    it('(a) null adapter value + null find() output → noop (bare passthrough converges)', () => {
      // Simulates: adapter yields { text: null }, find() returns { text: null }
      // (bare passthrough preserves null). The differ must see equal → noop.
      const d = new DeepEqualDiffer<Rec>();
      const adapterRecord = { text: null, externalId: 'x' };
      const findOutput = { text: null, externalId: 'x' };  // bare passthrough
      const result = d.diff(findOutput, adapterRecord);
      expect(result).toBe('noop');
    });

    it("(b) '' !== null under the differ — proving ?? '' coercion breaks convergence", () => {
      // Simulates what a blanket `text: row.text ?? ''` coercion WOULD emit:
      // find() returns { text: '' } but adapter yields { text: null }.
      // The differ does NOT equate '' and null → false → spurious upsert.
      // This is the exact diff-divergence bug the bare-passthrough rule prevents.
      const d = new DeepEqualDiffer<Rec>();
      const coercedFindOutput = { text: '' };
      const adapterRecord = { text: null };
      const result = d.diff(coercedFindOutput, adapterRecord);
      // Must NOT be noop — isEqual(null, '') is false (deep-equal.differ.ts:187-208, :220)
      expect(result).not.toBe('noop');
    });

    it('(c) 0 !== null and false !== null (same class — boolean/number coercions also break convergence)', () => {
      const d = new DeepEqualDiffer<Rec>();
      expect(d.diff({ count: 0 }, { count: null })).not.toBe('noop');
      expect(d.diff({ active: false }, { active: null })).not.toBe('noop');
    });

    it('(d) non-null scalar passthrough: string value preserved exactly → noop', () => {
      const d = new DeepEqualDiffer<Rec>();
      expect(d.diff({ text: 'hello' }, { text: 'hello' })).toBe('noop');
    });
  });
});
