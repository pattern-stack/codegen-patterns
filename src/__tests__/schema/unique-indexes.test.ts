/**
 * Tests for the entity-YAML top-level `unique_indexes:` block (#356).
 *
 * Composite (multi-column) unique constraints — e.g. UNIQUE (conversation_id,
 * sequence) — were silently rejected by the `.strict()` EntityDefinitionSchema
 * before this key existed (#356). Single-column uniqueness is also the field-level
 * `unique: true` flag. #784: entries take 1+ fields, `where:` (partial) and `nulls_not_distinct:`.
 */

import { describe, it, expect } from 'bun:test';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';

const base = {
  entity: { name: 'message', plural: 'messages' },
  fields: {
    conversation_id: { type: 'uuid', required: true },
    sequence: { type: 'integer', required: true },
  },
};

describe('unique_indexes block (#356)', () => {
  it('is optional', () => {
    const result = EntityDefinitionSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect(result.data!.unique_indexes).toBeUndefined();
  });

  it('accepts a composite unique index without an explicit name', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      unique_indexes: [{ fields: ['conversation_id', 'sequence'] }],
    });
    expect(result.success).toBe(true);
    expect(result.data!.unique_indexes).toEqual([
      { fields: ['conversation_id', 'sequence'] },
    ]);
  });

  it('accepts an explicit index name', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      unique_indexes: [
        { fields: ['conversation_id', 'sequence'], name: 'messages_conversation_sequence_uniq' },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data!.unique_indexes![0]!.name).toBe('messages_conversation_sequence_uniq');
  });

  it('accepts a single-field entry (#784)', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      unique_indexes: [{ fields: ['conversation_id'] }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty fields list at the fields path', () => {
    const result = EntityDefinitionSchema.safeParse({ ...base, unique_indexes: [{ fields: [] }] });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path).toEqual(['unique_indexes', 0, 'fields']);
  });

  it('accepts where + name, with or without nulls_not_distinct: false', () => {
    const entry = { fields: ['conversation_id'], where: 'sequence > 0', name: 'messages_open_uniq' };
    expect(EntityDefinitionSchema.safeParse({ ...base, unique_indexes: [entry] }).success).toBe(true);
    expect(
      EntityDefinitionSchema.safeParse({
        ...base,
        unique_indexes: [{ ...entry, nulls_not_distinct: false }],
      }).success,
    ).toBe(true);
  });

  it('rejects where without name, at the name path with the message', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      unique_indexes: [{ fields: ['conversation_id'], where: 'sequence > 0' }],
    });
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0]!;
    expect(issue.path).toEqual(['unique_indexes', 0, 'name']);
    expect(issue.message).toContain('`name` is required when `where` is set');
  });

  it('rejects where + nulls_not_distinct: true, naming the drizzle limit', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      unique_indexes: [
        { fields: ['conversation_id'], where: 'sequence > 0', name: 'x_uniq', nulls_not_distinct: true },
      ],
    });
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0]!;
    expect(issue.path).toEqual(['unique_indexes', 0, 'nulls_not_distinct']);
    expect(issue.message).toContain('rc.4');
  });

  it('rejects a blank where, a non-boolean nulls_not_distinct, a bad name and a 64-char name', () => {
    const ok = (entry: Record<string, unknown>) =>
      EntityDefinitionSchema.safeParse({
        ...base,
        unique_indexes: [{ fields: ['conversation_id'], ...entry }],
      }).success;
    expect(ok({ where: '   ', name: 'x_uniq' })).toBe(false);
    expect(ok({ nulls_not_distinct: 'yes' })).toBe(false);
    expect(ok({ name: "it's" })).toBe(false);
    expect(ok({ name: 'Upper_Case' })).toBe(false);
    expect(ok({ name: 'a'.repeat(64) })).toBe(false);
    expect(ok({ name: 'a'.repeat(63) })).toBe(true);
  });

  it('rejects unknown keys inside an entry (.strict())', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      unique_indexes: [{ fields: ['conversation_id', 'sequence'], bogus: true }],
    });
    expect(result.success).toBe(false);
  });
});
