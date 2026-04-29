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
  it('exposes clpEnumFields with enumName, dbName, and choices', () => {
    const locals = buildCleanLitePsLocals(integrationDefinition, EMPTY_BASE_LOCALS) as any;
    expect(locals.clpEnumFields).toEqual([
      { enumName: 'statusEnum', dbName: 'status', choices: ['active', 'paused', 'disabled'] },
    ]);
  });

  it('adds pgEnum to clpDrizzleImports when enum fields are present', () => {
    const locals = buildCleanLitePsLocals(integrationDefinition, EMPTY_BASE_LOCALS) as any;
    expect(locals.clpDrizzleImports).toContain('pgEnum');
  });

  it('produces a drizzleChain referencing the enum declaration, not text()', () => {
    const locals = buildCleanLitePsLocals(integrationDefinition, EMPTY_BASE_LOCALS) as any;
    const statusField = locals.clpProcessedFields.find((f: any) => f.name === 'status');
    expect(statusField.drizzleChain).toBe("statusEnum('status').notNull()");
    expect(statusField.tsType).toBe("'active' | 'paused' | 'disabled'");
  });

  it('renders pgEnum declaration above pgTable and column references it', () => {
    const locals = buildCleanLitePsLocals(integrationDefinition, EMPTY_BASE_LOCALS);
    const out = render(locals as Record<string, unknown>);

    // Top-of-file declaration
    expect(out).toContain(
      "export const statusEnum = pgEnum('status', ['active', 'paused', 'disabled']);",
    );
    // Column reference inside pgTable block
    expect(out).toContain("status: statusEnum('status').notNull()");
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
