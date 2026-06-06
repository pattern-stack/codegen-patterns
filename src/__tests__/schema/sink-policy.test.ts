/**
 * Tests for the entity-YAML `integration.sink` block (#490).
 *
 * Covers:
 *   - SinkPolicySchema: valid delete enum values; invalid enum rejected.
 *   - exclude_fields: valid string array; non-existent field rejected by
 *     superRefine; FK column rejected; user_id rejected.
 *   - Absence of any knob → entity parses cleanly (no regression for existing entities).
 */

import { describe, it, expect } from 'bun:test';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';

/** Minimal valid entity base with a couple of fields and a belongs_to. */
const base = {
  entity: {
    name: 'message',
    plural: 'messages',
    table: 'messages',
    pattern: 'Integrated',
    surface: 'messaging',
  },
  fields: {
    body: { type: 'string', required: true },
    conversation_external_id: { type: 'string', nullable: true },
    title: { type: 'string', nullable: true },
    // user_id is a copy-through field but protected by superRefine
    user_id: { type: 'uuid', required: true },
    // channel_id is a FK column (declared via belongs_to.foreign_key)
    channel_id: { type: 'uuid', required: true },
  },
  relationships: {
    channel: { type: 'belongs_to', target: 'channel', foreign_key: 'channel_id' },
  },
  integration: {
    providers: {
      slack: { remote_entity: 'message', direction: 'inbound' as const },
    },
  },
};

// ============================================================================
// Absence — no regression
// ============================================================================

describe('integration.sink — absence (no regression)', () => {
  it('parses a base entity with no integration.sink block', () => {
    const result = EntityDefinitionSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect(result.data?.integration?.sink).toBeUndefined();
  });

  it('parses when integration block is entirely absent', () => {
    const { integration: _i, ...noIntegration } = base;
    const result = EntityDefinitionSchema.safeParse(noIntegration);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// delete knob — valid values
// ============================================================================

describe('integration.sink.delete — valid enum values', () => {
  for (const value of ['soft', 'tombstone', 'noop'] as const) {
    it(`accepts delete: ${value}`, () => {
      const result = EntityDefinitionSchema.safeParse({
        ...base,
        integration: {
          ...base.integration,
          sink: { delete: value },
        },
      });
      expect(result.success).toBe(true);
      expect(result.data?.integration?.sink?.delete).toBe(value);
    });
  }

  it('delete is optional (absent parses)', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      integration: { ...base.integration, sink: {} },
    });
    expect(result.success).toBe(true);
    expect(result.data?.integration?.sink?.delete).toBeUndefined();
  });
});

// ============================================================================
// delete knob — invalid value rejected
// ============================================================================

describe('integration.sink.delete — invalid value rejected', () => {
  it('rejects delete: hard (not in enum)', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      integration: {
        ...base.integration,
        sink: { delete: 'hard' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects delete: false (wrong type)', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      integration: {
        ...base.integration,
        sink: { delete: false },
      },
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// exclude_fields — valid string array
// ============================================================================

describe('integration.sink.exclude_fields — valid entries', () => {
  it('accepts exclude_fields with a declared copy-through scalar', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      integration: {
        ...base.integration,
        sink: { exclude_fields: ['conversation_external_id'] },
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.integration?.sink?.exclude_fields).toEqual([
      'conversation_external_id',
    ]);
  });

  it('accepts exclude_fields with multiple declared scalars', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      integration: {
        ...base.integration,
        sink: { exclude_fields: ['conversation_external_id', 'title'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts exclude_fields: [] (empty array)', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      integration: {
        ...base.integration,
        sink: { exclude_fields: [] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts both delete and exclude_fields together', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      integration: {
        ...base.integration,
        sink: {
          delete: 'noop',
          exclude_fields: ['conversation_external_id'],
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.integration?.sink?.delete).toBe('noop');
    expect(result.data?.integration?.sink?.exclude_fields).toEqual([
      'conversation_external_id',
    ]);
  });
});

// ============================================================================
// exclude_fields — superRefine rejections (Note 1 from spec)
// ============================================================================

describe('integration.sink.exclude_fields — superRefine: non-existent field rejected', () => {
  it('rejects a field name that does not exist on the entity (typo)', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      integration: {
        ...base.integration,
        sink: { exclude_fields: ['typo_field_name'] },
      },
    });
    expect(result.success).toBe(false);
    const error = result.error!.errors.find((e) =>
      e.message.includes('typo_field_name'),
    );
    expect(error).toBeDefined();
  });
});

describe('integration.sink.exclude_fields — superRefine: FK column rejected', () => {
  it('rejects channel_id (a belongs_to foreign_key column)', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      integration: {
        ...base.integration,
        sink: { exclude_fields: ['channel_id'] },
      },
    });
    expect(result.success).toBe(false);
    const error = result.error!.errors.find((e) =>
      e.message.includes('channel_id') && e.message.includes('FK'),
    );
    expect(error).toBeDefined();
  });
});

describe('integration.sink.exclude_fields — superRefine: user_id rejected', () => {
  it('rejects user_id (used for user-scoping + EAV dual-write)', () => {
    const result = EntityDefinitionSchema.safeParse({
      ...base,
      integration: {
        ...base.integration,
        sink: { exclude_fields: ['user_id'] },
      },
    });
    expect(result.success).toBe(false);
    const error = result.error!.errors.find((e) =>
      e.message.includes('user_id'),
    );
    expect(error).toBeDefined();
  });
});
