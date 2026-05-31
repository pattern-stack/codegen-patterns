/**
 * Tests for the entity-YAML top-level `unique_indexes:` block (#356).
 *
 * Composite (multi-column) unique constraints — e.g. UNIQUE (conversation_id,
 * sequence) — were silently rejected by the `.strict()` EntityDefinitionSchema
 * before this key existed. Single-column uniqueness stays the field-level
 * `unique: true` flag; this block is for constraints spanning 2+ columns.
 */

import { describe, it, expect } from 'bun:test';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';

const base = {
  entity: { name: 'message', plural: 'messages', table: 'messages' },
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

  it('rejects a single-column unique index (use field `unique: true` instead)', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      unique_indexes: [{ fields: ['conversation_id'] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside an entry (.strict())', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      unique_indexes: [{ fields: ['conversation_id', 'sequence'], bogus: true }],
    });
    expect(result.success).toBe(false);
  });
});
