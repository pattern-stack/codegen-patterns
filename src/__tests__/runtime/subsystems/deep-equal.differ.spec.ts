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
});
