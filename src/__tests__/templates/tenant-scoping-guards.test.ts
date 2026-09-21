/**
 * TEN-1 (#585) / #636 — the two generation-time decisions that live in
 * `templates/entity/new/prompt.js`, above the per-pipeline locals.
 *
 *   1. `assertTenantScopingSupported` — a `tenant_scoped: true` entity outside
 *      `clean-lite-ps` is refused, because that pipeline cannot honour the flag
 *      and emitting an unscoped repository that claims isolation is worse than
 *      failing (#602, charter I11).
 *   2. `loadOwnedTableNames` — which Drizzle tables codegen generates, read
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
  assertTenantScopingSupported,
  loadOwnedTableNames,
} from '../../../templates/entity/new/prompt.js';

const tenantScopedNote = {
  entity: { name: 'note', plural: 'notes', table: 'notes' },
  tenant_scoped: true,
};

describe('assertTenantScopingSupported (TEN-1 §4.2)', () => {
  it('permits tenant_scoped under clean-lite-ps', () => {
    expect(() =>
      assertTenantScopingSupported(tenantScopedNote, 'clean-lite-ps'),
    ).not.toThrow();
  });

  it('refuses tenant_scoped under the clean pipeline', () => {
    expect(() => assertTenantScopingSupported(tenantScopedNote, 'clean')).toThrow(
      /tenant_scoped: true requires generate\.architecture: 'clean-lite-ps'/,
    );
  });

  it('names the entity and the architecture in the message', () => {
    try {
      assertTenantScopingSupported(tenantScopedNote, 'clean');
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as Error).message).toContain("Entity 'note'");
      expect((err as Error).message).toContain("this project is 'clean'");
      expect((err as Error).message).toContain('ADR-042');
    }
  });

  it('is silent for an entity that does not declare the flag', () => {
    const plain = { entity: { name: 'note' } };
    expect(() => assertTenantScopingSupported(plain, 'clean')).not.toThrow();
    expect(() => assertTenantScopingSupported(plain, 'clean-lite-ps')).not.toThrow();
  });

  it('treats a non-true value as absent — only `true` opts in', () => {
    expect(() =>
      assertTenantScopingSupported({ entity: { name: 'n' }, tenant_scoped: false }, 'clean'),
    ).not.toThrow();
  });
});

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

  it('reads the table name from entity.table', () => {
    const root = project({
      'entities/note.yaml': 'entity:\n  name: note\n  plural: notes\n  table: notes\n',
    });
    expect([...loadOwnedTableNames(root, 'entities')]).toEqual(['notes']);
  });

  it('falls back to entity.plural, then to the pluralized name', () => {
    const root = project({
      'entities/a.yaml': 'entity:\n  name: person\n  plural: people\n',
      'entities/b.yaml': 'entity:\n  name: widget\n',
    });
    const owned = loadOwnedTableNames(root, 'entities');
    expect(owned.has('people')).toBe(true);
    expect(owned.has('widgets')).toBe(true);
  });

  it('walks nested directories', () => {
    const root = project({
      'entities/crm/account.yaml': 'entity:\n  name: account\n  table: accounts\n',
    });
    expect(loadOwnedTableNames(root, 'entities').has('accounts')).toBe(true);
  });

  it('skips a malformed YAML instead of sinking the whole set', () => {
    const root = project({
      'entities/good.yaml': 'entity:\n  name: note\n  table: notes\n',
      'entities/bad.yaml': 'entity: [unclosed\n',
      'entities/notes.txt': 'entity:\n  name: ignored\n  table: ignored\n',
    });
    const owned = loadOwnedTableNames(root, 'entities');
    expect(owned.has('notes')).toBe(true);
    expect(owned.has('ignored')).toBe(false);
  });

  it('returns an empty set when the project has no entities directory', () => {
    const root = project({ 'README.md': 'nothing here' });
    expect(loadOwnedTableNames(root, 'entities').size).toBe(0);
  });

  it('does not include a table only present as a foreign_key target', () => {
    // The whole point: `tenants` is referenced but never declared, so it is
    // host-owned and gets no DB-level FK.
    const root = project({
      'entities/note.yaml':
        'entity:\n  name: note\n  table: notes\n' +
        'fields:\n  tenant_id:\n    type: uuid\n    foreign_key: tenants.id\n',
    });
    const owned = loadOwnedTableNames(root, 'entities');
    expect(owned.has('notes')).toBe(true);
    expect(owned.has('tenants')).toBe(false);
  });
});
