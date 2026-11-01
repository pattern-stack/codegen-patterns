import { describe, expect, test } from 'bun:test';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import { RelationshipDefinitionSchema } from '../../schema/relationship-definition.schema';
import {
  generatedTypeName,
  RESERVED_ENTITY_TYPE_NAMES,
  reservedGlobalFor,
} from '../../schema/reserved-entity-names';

const entity = (name: string) => ({
  entity: { name, plural: `${name}s`, table: `${name}s` },
  fields: { body: { type: 'string' } },
});

describe('reserved entity names (#813)', () => {
  test('reservedGlobalFor names the three reserved globals', () => {
    expect(reservedGlobalFor('promise')?.global).toBe('Promise');
    expect(reservedGlobalFor('array')?.global).toBe('Array');
    expect(reservedGlobalFor('date')?.global).toBe('Date');
  });

  test('everything else is made to work, not reserved', () => {
    for (const n of [
      'record', 'item', 'map', 'set', 'error', 'event', 'object', 'number',
      'symbol', 'function', 'json', 'date_range', 'promise_item',
    ]) {
      expect(reservedGlobalFor(n)).toBeNull();
    }
  });

  test('generatedTypeName', () => {
    expect(generatedTypeName('deal_state')).toBe('DealState');
  });

  test.each(['promise', 'array', 'date'])('entity name %s gives one issue at entity.name', (name) => {
    const r = EntityDefinitionSchema.safeParse(entity(name));
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toHaveLength(1);
    const issue = r.error.issues[0];
    expect(issue.path).toEqual(['entity', 'name']);
    expect(issue.code).toBe('custom');
    expect(issue.message).toContain(`'${name}'`);
    expect(issue.message).toContain(reservedGlobalFor(name)!.global);
  });

  test.each(['record', 'item', 'map', 'error'])('entity name %s parses', (name) => {
    expect(EntityDefinitionSchema.safeParse(entity(name)).success).toBe(true);
  });

  test('relationship name date gives one issue at relationship.name', () => {
    const r = RelationshipDefinitionSchema.safeParse({
      relationship: { name: 'date', from: 'person', to: 'organization' },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues).toHaveLength(1);
    expect(r.error.issues[0].path).toEqual(['relationship', 'name']);
    expect(r.error.issues[0].code).toBe('custom');
  });

  test('every reserved global is one PascalCase word (keeps junction names safe)', () => {
    for (const r of RESERVED_ENTITY_TYPE_NAMES) expect(r.global).toMatch(/^[A-Z][a-z0-9]*$/);
  });
});
