/**
 * Template rendering tests for clean-lite-ps entity pgEnum emission (0.6.8 hotfix).
 *
 * Pre-fix: enum-typed YAML fields fell through to `text('status').notNull()`,
 * so `InferSelectModel` returned `string` instead of the literal union and
 * forced hand-casts in consumer code (e.g. integration-patterns
 * apps/api/src/modules/integrations/facade/integrations.service.ts).
 *
 * Post-fix: enum fields emit a top-of-file `pgEnum` declaration plus a
 * column reference to that declaration, matching the backend pipeline at
 * templates/entity/new/backend/database/schema.ejs.t:66-104.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildCleanLitePsLocals } from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';

const ENTITY_TEMPLATE = readFileSync(
  resolve(import.meta.dir, '../../../templates/entity/new/clean-lite-ps/entity.ejs.t'),
  'utf8',
);

function extractBody(source: string): string {
  const lines = source.split('\n');
  if (lines[0] !== '---') return source;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return source;
  return lines.slice(end + 1).join('\n');
}

function render(locals: Record<string, unknown>): string {
  return ejs.render(extractBody(ENTITY_TEMPLATE), locals, { rmWhitespace: false });
}

const EMPTY_BASE_LOCALS = {};

const integrationDefinition = {
  entity: { name: 'integration', plural: 'integrations', table: 'integrations', pattern: 'Base' },
  fields: {
    name: { type: 'string', required: true },
    status: { type: 'enum', choices: ['active', 'paused', 'disabled'], required: true },
  },
  relationships: {},
  behaviors: ['timestamps'],
};

describe('clean-lite-ps entity template — pgEnum emission', () => {
  it('exposes clpEnumFields with entity-namespaced enumName, dbName, and choices', () => {
    const locals = buildCleanLitePsLocals(integrationDefinition, EMPTY_BASE_LOCALS) as any;
    // Both the exported const (enumName) and the pg TYPE name (dbName) are
    // namespaced by entity so a same-named enum field on another entity can't
    // collide (TS2308 / duplicate CREATE TYPE).
    expect(locals.clpEnumFields).toEqual([
      {
        enumName: 'integrationStatusEnum',
        dbName: 'integration_status',
        choices: ['active', 'paused', 'disabled'],
      },
    ]);
  });

  it('adds pgEnum to clpDrizzleImports when enum fields are present', () => {
    const locals = buildCleanLitePsLocals(integrationDefinition, EMPTY_BASE_LOCALS) as any;
    expect(locals.clpDrizzleImports).toContain('pgEnum');
  });

  it('produces a drizzleChain referencing the namespaced enum const, not text()', () => {
    const locals = buildCleanLitePsLocals(integrationDefinition, EMPTY_BASE_LOCALS) as any;
    const statusField = locals.clpProcessedFields.find((f: any) => f.name === 'status');
    // The const is namespaced; the COLUMN name stays the bare field name.
    expect(statusField.drizzleChain).toBe("integrationStatusEnum('status').notNull()");
    expect(statusField.tsType).toBe("'active' | 'paused' | 'disabled'");
  });

  it('renders pgEnum declaration above pgTable and column references it', () => {
    const locals = buildCleanLitePsLocals(integrationDefinition, EMPTY_BASE_LOCALS);
    const out = render(locals as Record<string, unknown>);

    // Top-of-file declaration — const + pg TYPE name both namespaced by entity.
    expect(out).toContain(
      "export const integrationStatusEnum = pgEnum('integration_status', ['active', 'paused', 'disabled']);",
    );
    // Column reference inside pgTable block — namespaced const, bare column name.
    expect(out).toContain("status: integrationStatusEnum('status').notNull()");
    // No text() fallback for the enum column
    expect(out).not.toMatch(/status: text\('status'\)/);
    // pgEnum import present
    expect(out).toMatch(/pgEnum,/);
  });

  it('preserves text/string columns alongside enum columns', () => {
    const locals = buildCleanLitePsLocals(integrationDefinition, EMPTY_BASE_LOCALS) as any;
    expect(locals.clpDrizzleImports).toContain('text');
    const out = render(locals);
    expect(out).toContain("name: text('name').notNull()");
  });

  it('omits clpEnumFields and pgEnum import when no enum fields present', () => {
    const noEnum = {
      entity: { name: 'task', plural: 'tasks', table: 'tasks', pattern: 'Base' },
      fields: { title: { type: 'string', required: true } },
      relationships: {},
      behaviors: [],
    };
    const locals = buildCleanLitePsLocals(noEnum, EMPTY_BASE_LOCALS) as any;
    expect(locals.clpEnumFields).toEqual([]);
    expect(locals.clpDrizzleImports).not.toContain('pgEnum');
  });
});

describe('clean-lite-ps entity template — enum namespacing across entities (no collision)', () => {
  // Regression: two entities that each declare an enum field with the SAME name
  // (`role`) must produce DISTINCT enum consts AND distinct pg type names.
  // Pre-fix both emitted `export const roleEnum = pgEnum('role', …)`, which is a
  // duplicate barrel export (TS2308) and a duplicate `CREATE TYPE role` at the
  // DB level (a real migration conflict). Hit building a real consumer app.
  const fieldConfig = {
    entity: { name: 'field_config', plural: 'field_configs', table: 'field_configs', pattern: 'Base' },
    fields: { role: { type: 'enum', choices: ['a', 'b'], required: true } },
    relationships: {},
    behaviors: [],
  };
  const canonicalField = {
    entity: { name: 'canonical_field', plural: 'canonical_fields', table: 'canonical_fields', pattern: 'Base' },
    fields: { role: { type: 'enum', choices: ['a', 'b'], required: true } },
    relationships: {},
    behaviors: [],
  };

  it('namespaces the enum const + pg type name by entity', () => {
    const a = buildCleanLitePsLocals(fieldConfig, EMPTY_BASE_LOCALS) as any;
    const b = buildCleanLitePsLocals(canonicalField, EMPTY_BASE_LOCALS) as any;

    expect(a.clpEnumFields).toEqual([
      { enumName: 'fieldConfigRoleEnum', dbName: 'field_config_role', choices: ['a', 'b'] },
    ]);
    expect(b.clpEnumFields).toEqual([
      { enumName: 'canonicalFieldRoleEnum', dbName: 'canonical_field_role', choices: ['a', 'b'] },
    ]);

    // Distinct const names → no duplicate barrel export (TS2308).
    expect(a.clpEnumFields[0].enumName).not.toBe(b.clpEnumFields[0].enumName);
    // Distinct pg type names → no duplicate CREATE TYPE.
    expect(a.clpEnumFields[0].dbName).not.toBe(b.clpEnumFields[0].dbName);
  });

  it('emits distinct pgEnum declarations + column references in the rendered files', () => {
    const aOut = render(buildCleanLitePsLocals(fieldConfig, EMPTY_BASE_LOCALS) as Record<string, unknown>);
    const bOut = render(buildCleanLitePsLocals(canonicalField, EMPTY_BASE_LOCALS) as Record<string, unknown>);

    expect(aOut).toContain("export const fieldConfigRoleEnum = pgEnum('field_config_role', ['a', 'b']);");
    expect(aOut).toContain("role: fieldConfigRoleEnum('role').notNull()");

    expect(bOut).toContain("export const canonicalFieldRoleEnum = pgEnum('canonical_field_role', ['a', 'b']);");
    expect(bOut).toContain("role: canonicalFieldRoleEnum('role').notNull()");

    // Neither file emits the bare, un-namespaced const that previously collided.
    expect(aOut).not.toContain("export const roleEnum = pgEnum('role'");
    expect(bOut).not.toContain("export const roleEnum = pgEnum('role'");
  });
});
