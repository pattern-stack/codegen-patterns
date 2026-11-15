/**
 * C5 — every name an entity table's extra-config callback declares (index, unique, composite FK, CHECK) is at most 63 bytes.
 *
 * Postgres keeps 63 bytes of an identifier and truncates the rest without a
 * word, so two names that differ only after byte 63 are one constraint to the
 * database. Those names pass through `assertDistinctConstraints`, so the
 * rule is stated once, there. NOT covered: the names Drizzle derives for a single-column `.references()` FK,
 * pgEnum type names, and junction / relationship tables
 * (explicit FK names are #921's).
 */

import { describe, expect, it } from 'bun:test';

import {
  assertDistinctConstraints,
  buildBackendLocals,
  PG_IDENTIFIER_MAX_BYTES,
} from '../../../templates/entity/new/backend/entity-locals.js';
import { withEntities } from './_entity-lookup';

const entry = (name: string) => ({ name, builder: 'index', expr: `index('${name}')`, source: 'test' });

describe('assertDistinctConstraints — C5, the 63-byte limit', () => {
  it('accepts a name of exactly 63 bytes', () => {
    expect(() => assertDistinctConstraints([entry('a'.repeat(PG_IDENTIFIER_MAX_BYTES))], 'thing')).not.toThrow();
  });

  it('rejects 64 bytes, naming the entity, the name and entity.table: as the escape hatch', () => {
    const name = 'a'.repeat(PG_IDENTIFIER_MAX_BYTES + 1);
    expect(() => assertDistinctConstraints([entry(name)], 'thing')).toThrow(/'thing'.*64 bytes.*entity\.table:/s);
  });

  it('counts bytes, not characters', () => {
    expect(() => assertDistinctConstraints([entry('é'.repeat(32))], 'thing')).toThrow(/64 bytes/);
  });

  it('a long entity name fails generation on its own tenant index, a name that predates RFC-0006', () => {
    const long = 'a_very_long_entity_name_that_overflows_the_limit_of_sixty_three';
    const def = {
      entity: { name: long, plural: `${long}s`, pattern: 'Base' },
      fields: { title: { type: 'string', required: true, index: true } },
      relationships: {},
      behaviors: [],
    };
    expect(() => buildBackendLocals(def, withEntities())).toThrow(/Postgres keeps 63/);
  });

  it('entity.table: shortens every name, which is the way out', () => {
    const long = 'a_very_long_entity_name_that_overflows_the_limit_of_sixty_three';
    const def = {
      entity: { name: long, plural: `${long}s`, table: 'short_table', pattern: 'Base' },
      fields: { title: { type: 'string', required: true, index: true } },
      relationships: {},
      behaviors: [],
    };
    expect(() => buildBackendLocals(def, withEntities())).not.toThrow();
  });
});
