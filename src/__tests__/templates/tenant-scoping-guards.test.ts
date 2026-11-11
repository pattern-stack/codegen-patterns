/**
 * #636 — the generation-time decision that lives in
 * `templates/entity/new/prompt.js`, above the per-pipeline locals.
 *
 * TEN-1's companion guard (`assertTenantScopingSupported`) went with ARCH-0
 * (#677): it existed to refuse `tenant_scoped: true` under the `clean`
 * pipeline, and that pipeline no longer exists.
 *
 *   `loadOwnedTableNames` — which Drizzle tables codegen generates, read
 *      from the entity YAMLs themselves. It decides whether a field-level
 *      `foreign_key:` gets a DB-level FK or is host-owned (#636). Reading it
 *      from the YAML rather than from emitted files is what makes a two-pass
 *      generation give the same answer on both passes (charter I1).
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadOwnedTableNames,
} from '../../../templates/entity/new/prompt.js';

const tenantScopedNote = {
  entity: { name: 'note', plural: 'notes' },
  tenant_scoped: true,
};

describe('loadOwnedTableNames (#636)', () => {
  function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'owned-tables-'));
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    }
    return root;
  }

  it('reads the SQL table name: plural by default (TABLE-0)', () => {
    const root = project({
      'entities/note.yaml': 'entity:\n  name: note\n  plural: notes\n',
    });
    expect([...loadOwnedTableNames(root, { tablePrefix: '', entitiesDir: 'entities' })]).toEqual(['notes']);
  });

  it('a table_name is the owned table, not the plural (TABLE-0)', () => {
    const root = project({
      'entities/ticket.yaml': 'entity:\n  name: ticket\n  plural: tickets\n  table_name: issues\n',
    });
    expect([...loadOwnedTableNames(root, { tablePrefix: 'db_', entitiesDir: 'entities' })]).toEqual(['issues']);
  });

  it('the project prefix and an entity table_prefix reach the owned name (TABLE-0)', () => {
    const root = project({
      'entities/note.yaml': 'entity:\n  name: note\n  plural: notes\n',
      'entities/deal.yaml': "entity:\n  name: deal\n  plural: deals\n  table_prefix: crm__\n",
      'entities/tag.yaml': "entity:\n  name: tag\n  plural: tags\n  table_prefix: ''\n",
    });
    expect([...loadOwnedTableNames(root, { tablePrefix: 'app_', entitiesDir: 'entities' })].sort()).toEqual([
      'app_notes',
      'crm__deals',
      'tags',
    ]);
  });

  it('requires the prefix — an absent one is an error, never a silent unprefixed set', () => {
    const root = project({ 'entities/note.yaml': 'entity:\n  name: note\n  plural: notes\n' });
    // @ts-expect-error — the missing key is the point
    expect(() => loadOwnedTableNames(root, { entitiesDir: 'entities' })).toThrow(/tablePrefix/);
  });

  it('falls back to entity.plural, then to the pluralized name', () => {
    const root = project({
      'entities/a.yaml': 'entity:\n  name: person\n  plural: people\n',
      'entities/b.yaml': 'entity:\n  name: widget\n',
    });
    const owned = loadOwnedTableNames(root, { tablePrefix: '', entitiesDir: 'entities' });
    expect(owned.has('people')).toBe(true);
    expect(owned.has('widgets')).toBe(true);
  });

  it('walks nested directories', () => {
    const root = project({
      'entities/crm/account.yaml': 'entity:\n  name: account\n',
    });
    expect(loadOwnedTableNames(root, { tablePrefix: '', entitiesDir: 'entities' }).has('accounts')).toBe(true);
  });

  it('skips a malformed YAML instead of sinking the whole set', () => {
    const root = project({
      'entities/good.yaml': 'entity:\n  name: note\n',
      'entities/bad.yaml': 'entity: [unclosed\n',
      'entities/notes.txt': 'entity:\n  name: ignored\n',
    });
    const owned = loadOwnedTableNames(root, { tablePrefix: '', entitiesDir: 'entities' });
    expect(owned.has('notes')).toBe(true);
    expect(owned.has('ignored')).toBe(false);
  });

  it('returns an empty set when the project has no entities directory', () => {
    const root = project({ 'README.md': 'nothing here' });
    expect(loadOwnedTableNames(root, { tablePrefix: '', entitiesDir: 'entities' }).size).toBe(0);
  });

  it('does not include a table only present as a foreign_key target', () => {
    // The whole point: `tenants` is referenced but never declared, so it is
    // host-owned and gets no DB-level FK.
    const root = project({
      'entities/note.yaml':
        'entity:\n  name: note\n' +
        'fields:\n  tenant_id:\n    type: uuid\n    foreign_key: tenants.id\n',
    });
    const owned = loadOwnedTableNames(root, { tablePrefix: '', entitiesDir: 'entities' });
    expect(owned.has('notes')).toBe(true);
    expect(owned.has('tenants')).toBe(false);
  });
});
