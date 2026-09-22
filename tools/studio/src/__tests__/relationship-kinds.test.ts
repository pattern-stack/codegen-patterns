/**
 * The kind registry is the mechanism that keeps #679's collapse of
 * `pattern: Junction` and `relationship:` a one-file edit. These tests hold
 * the invariants that make that true.
 */
import { describe, expect, test } from 'bun:test';
import {
  RELATIONSHIP_KINDS,
  RELATIONSHIP_OPTIONS,
  kindDescriptor,
  optionsFor,
  parseList,
  pruneOptions,
} from '../inspector/relationship-kinds';

describe('the registry', () => {
  test('every kind names only options the registry describes', () => {
    for (const kind of RELATIONSHIP_KINDS) {
      for (const id of kind.options) {
        expect(RELATIONSHIP_OPTIONS[id]).toBeDefined();
      }
    }
  });

  test('kind ids are unique', () => {
    const ids = RELATIONSHIP_KINDS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('an unknown kind is rejected rather than silently rendering nothing', () => {
    // @ts-expect-error -- deliberately outside the contract's union
    expect(() => kindDescriptor('sideways')).toThrow();
  });

  test('optionsFor preserves the declared order', () => {
    expect(optionsFor('many_to_many').map((o) => o.id)).toEqual([
      'through',
      'name',
      'types',
      'temporal',
      'sourced',
    ]);
  });
});

describe('pruneOptions', () => {
  test('drops options that do not apply to the kind', () => {
    // `onDelete` is a belongs_to option; setting it on a junction must not
    // reach the server.
    expect(pruneOptions('many_to_many', { onDelete: 'cascade', through: 'person_org' })).toEqual({
      through: 'person_org',
    });
  });

  test('drops values left at their default', () => {
    expect(pruneOptions('many_to_many', { temporal: true, sourced: true })).toBeUndefined();
    expect(pruneOptions('belongs_to', { onDelete: 'restrict', required: false })).toBeUndefined();
  });

  test('keeps values moved off their default', () => {
    expect(pruneOptions('many_to_many', { temporal: false })).toEqual({ temporal: false });
    expect(pruneOptions('belongs_to', { required: true, onDelete: 'cascade' })).toEqual({
      required: true,
      onDelete: 'cascade',
    });
  });

  test('trims text and drops it when empty', () => {
    expect(pruneOptions('belongs_to', { name: '  owner  ' })).toEqual({ name: 'owner' });
    expect(pruneOptions('belongs_to', { name: '   ' })).toBeUndefined();
  });

  test('parses a list option and drops it when empty', () => {
    expect(pruneOptions('many_to_many', { types: 'employed_by, advises' })).toEqual({
      types: ['employed_by', 'advises'],
    });
    expect(pruneOptions('many_to_many', { types: ' , ' })).toBeUndefined();
  });

  test('returns undefined rather than an empty object', () => {
    expect(pruneOptions('has_many', {})).toBeUndefined();
  });
});

describe('parseList', () => {
  test('splits on commas and newlines, trimming each item', () => {
    expect(parseList('a, b\n c ')).toEqual(['a', 'b', 'c']);
  });

  test('de-duplicates', () => {
    expect(parseList('a, a, b')).toEqual(['a', 'b']);
  });

  test('a non-string is an empty list', () => {
    expect(parseList(undefined)).toEqual([]);
    expect(parseList(true)).toEqual([]);
  });
});
