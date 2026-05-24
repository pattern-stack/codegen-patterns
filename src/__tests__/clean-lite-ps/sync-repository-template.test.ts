/**
 * Template-emission tests for the synced-entity sync surface (#374).
 *
 * Verifies that `pattern: Synced` repositories emit:
 *   - TSyncWrite / TSyncProjection interfaces (nullable-aware, FK write-keys,
 *     projection omits provider/providerMetadata)
 *   - the hand-emitted syncConfig literal with LIVE refTable handles
 *     ('self' for self-FK; imported parent table for non-self synced FK)
 *   - deduped parent-table imports (#368)
 *   - the widened `extends SyncedEntityRepository<E, EWrite, EProjection>`
 *   - the eav writeCustomFields override + FieldValueService injection
 * and that non-Synced entities emit none of it.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import {
  buildCleanLitePsLocals,
  buildSyncSurface,
} from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';

const REPO_TEMPLATE = readFileSync(
  resolve(import.meta.dir, '../../../templates/entity/new/clean-lite-ps/repository.ejs.t'),
  'utf8',
);

function extractBody(source: string): string {
  const lines = source.split('\n');
  if (lines[0] !== '---') return source;
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { end = i; break; }
  return end === -1 ? source : lines.slice(end + 1).join('\n');
}
const render = (locals: Record<string, unknown>) =>
  ejs.render(extractBody(REPO_TEMPLATE), locals, { rmWhitespace: false });

// ============================================================================
// Fixtures
// ============================================================================

// Self-FK synced entity (the account oracle shape).
const account = {
  entity: { name: 'account', plural: 'accounts', table: 'accounts', pattern: 'Synced' },
  fields: {
    user_id: { type: 'uuid', required: true },
    name: { type: 'string', required: true },
    domain: { type: 'string', nullable: true },
    employee_count: { type: 'integer', nullable: true },
  },
  behaviors: ['timestamps'],
  relationships: {
    parent_account: {
      type: 'belongs_to', target: 'account', foreign_key: 'parent_account_id',
      nullable: true, on_delete: 'set_null',
    },
  },
};

// Non-self synced FK (contact belongs_to account) + soft_delete + eav.
const contact = {
  entity: { name: 'contact', plural: 'contacts', table: 'contacts', pattern: 'Synced' },
  eav: true,
  fields: {
    user_id: { type: 'uuid', required: true },
    email: { type: 'string', required: true },
  },
  behaviors: ['timestamps', 'soft_delete'],
  relationships: {
    account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id', nullable: true },
  },
};

// Plain Base entity — emits no sync surface.
const widget = {
  entity: { name: 'widget', plural: 'widgets', table: 'widgets', pattern: 'Base' },
  fields: { label: { type: 'string', required: true } },
  behaviors: [],
};

// ============================================================================
// buildSyncSurface (pure derivation)
// ============================================================================

describe('buildSyncSurface derivation', () => {
  it('returns null for non-Synced patterns', () => {
    expect(buildSyncSurface('Base', [], [], true, false, false)).toBeNull();
  });

  it('derives writeColumns from non-FK fields and conflictTarget (provider, externalId)', () => {
    const locals = buildCleanLitePsLocals(account, {});
    expect(locals.clpSyncConfig).not.toBeNull();
    const cfg = locals.clpSyncConfig as any;
    expect(cfg.conflictTarget).toEqual(['provider', 'externalId']);
    expect(cfg.writeColumns).toEqual(['userId', 'name', 'domain', 'employeeCount']);
  });

  it('names the FK write-key ${relationKey}ExternalId and self-FK refTable self', () => {
    const locals = buildCleanLitePsLocals(account, {});
    const fk = (locals.clpSyncFkResolvers as any[])[0];
    expect(fk.column).toBe('parentAccountId');
    expect(fk.writeKey).toBe('parentAccountExternalId');
    expect(fk.isSelfFk).toBe(true);
  });

  it('non-self synced FK uses target table name + adds a parent import', () => {
    const locals = buildCleanLitePsLocals(contact, {});
    const fk = (locals.clpSyncFkResolvers as any[])[0];
    expect(fk.column).toBe('accountId');
    expect(fk.writeKey).toBe('accountExternalId');
    expect(fk.isSelfFk).toBe(false);
    expect(fk.refTable).toBe('accounts');
    expect(locals.clpSyncParentTableImports).toEqual([
      { table: 'accounts', importPath: '../accounts/account.entity' },
    ]);
  });

  it('self-FK contributes NO parent import', () => {
    const locals = buildCleanLitePsLocals(account, {});
    expect(locals.clpSyncParentTableImports).toEqual([]);
  });

  it('projectionColumns include id/externalId/FK/timestamps, never provider', () => {
    const locals = buildCleanLitePsLocals(account, {});
    const cfg = locals.clpSyncConfig as any;
    expect(cfg.projectionColumns).toEqual([
      'id', 'externalId', 'userId', 'name', 'domain', 'employeeCount',
      'parentAccountId', 'createdAt', 'updatedAt',
    ]);
    expect(cfg.projectionColumns).not.toContain('provider');
  });
});

// ============================================================================
// Emitted output
// ============================================================================

describe('synced repository emission — self-FK (account)', () => {
  const out = render(buildCleanLitePsLocals(account, {}) as Record<string, unknown>);

  it('emits TSyncWrite with nullable-aware fields + FK write-key', () => {
    expect(out).toContain('export interface AccountSyncWrite {');
    expect(out).toContain('readonly externalId: string;');
    expect(out).toContain('readonly domain: string | null;');
    expect(out).toContain('readonly employeeCount: number | null;');
    expect(out).toContain('readonly parentAccountExternalId?: string | null;');
    expect(out).toContain('readonly fields?: Record<string, unknown>;');
  });

  it('emits TSyncProjection omitting provider/providerMetadata', () => {
    expect(out).toContain('export interface AccountSyncProjection {');
    expect(out).toContain('readonly parentAccountId: string | null;');
    expect(out).toContain('readonly createdAt: Date;');
    expect(out).not.toContain('readonly provider:');
    expect(out).not.toContain('readonly providerMetadata');
  });

  it('widens the extends clause to the three-param base', () => {
    expect(out).toContain('extends SyncedEntityRepository<');
    expect(out).toContain('AccountSyncWrite,');
    expect(out).toContain('AccountSyncProjection');
  });

  it('emits the syncConfig literal with refTable: \'self\' (not HTML-escaped)', () => {
    expect(out).toContain("refTable: 'self'");
    expect(out).not.toContain('&#39;');
    expect(out).toContain("conflictTarget: ['provider', 'externalId']");
    expect(out).toContain('protected readonly syncConfig: SyncUpsertConfig = {');
  });

  it('imports SyncUpsertConfig + DrizzleTx', () => {
    expect(out).toContain("import type { SyncUpsertConfig } from '@shared/base-classes/sync-upsert-config';");
    expect(out).toContain('DrizzleTx');
  });

  it('updates the inherited-methods comment to the now-real methods', () => {
    expect(out).toContain('syncUpsertOne, findByExternalIdProjected, softDeleteByExternalId, syncUpsert');
  });

  it('does NOT emit an eav override for a non-eav entity', () => {
    expect(out).not.toContain('FieldValueService');
    expect(out).not.toContain('writeCustomFields');
  });
});

describe('synced repository emission — non-self FK + eav (contact)', () => {
  const out = render(buildCleanLitePsLocals(contact, {}) as Record<string, unknown>);

  it('imports the parent table as a live handle and uses it in fkResolvers', () => {
    expect(out).toContain("import { accounts } from '../accounts/account.entity';");
    expect(out).toContain("{ column: 'accountId', writeKey: 'accountExternalId', refTable: accounts }");
  });

  it('emits eav: true + FieldValueService injection + writeCustomFields override', () => {
    expect(out).toContain('eav: true');
    expect(out).toContain("import { FieldValueService } from '../field_values/field_value.service';");
    expect(out).toContain('private readonly fieldValues: FieldValueService,');
    expect(out).toContain('protected override async writeCustomFields(');
    expect(out).toContain("this.fieldValues.upsertFieldsTransactional('contact', entityId, userId, fields, db)");
  });

  it('threads softDelete: true into the syncConfig', () => {
    expect(out).toContain('softDelete: true');
  });
});

describe('non-Synced repository emission', () => {
  const out = render(buildCleanLitePsLocals(widget, {}) as Record<string, unknown>);

  it('emits no sync surface', () => {
    expect(out).not.toContain('SyncWrite');
    expect(out).not.toContain('SyncProjection');
    expect(out).not.toContain('syncConfig');
    expect(out).not.toContain('SyncUpsertConfig');
  });

  it('keeps the single-param extends', () => {
    expect(out).toContain('extends BaseRepository<Widget> {');
  });
});
