/**
 * Template-emission tests for the integrated-entity integration surface (#374).
 *
 * Verifies that `pattern: Integrated` repositories emit:
 *   - TIntegrationWrite / TIntegrationProjection interfaces (nullable-aware, FK write-keys,
 *     projection omits provider/providerMetadata)
 *   - the hand-emitted integrationConfig literal with LIVE refTable handles
 *     ('self' for self-FK; imported parent table for non-self integrated FK)
 *   - deduped parent-table imports (#368)
 *   - the widened `extends IntegratedEntityRepository<E, EWrite, EProjection>`
 *   - the eav writeCustomFields override + FieldValueService injection
 * and that non-Integrated entities emit none of it.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import {
  buildCleanLitePsLocals,
  buildIntegrationSurface,
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

// Self-FK integrated entity (the account oracle shape).
const account = {
  entity: { name: 'account', plural: 'accounts', table: 'accounts', pattern: 'Integrated' },
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

// Non-self integrated FK (contact belongs_to account) + soft_delete + eav.
const contact = {
  entity: { name: 'contact', plural: 'contacts', table: 'contacts', pattern: 'Integrated' },
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

// Plain Base entity — emits no integration surface.
const widget = {
  entity: { name: 'widget', plural: 'widgets', table: 'widgets', pattern: 'Base' },
  fields: { label: { type: 'string', required: true } },
  behaviors: [],
};

// ============================================================================
// buildIntegrationSurface (pure derivation)
// ============================================================================

describe('buildIntegrationSurface derivation', () => {
  it('returns null for non-Integrated patterns', () => {
    expect(buildIntegrationSurface('Base', [], [], true, false, false)).toBeNull();
  });

  it('derives writeColumns from non-FK fields and conflictTarget (provider, externalId)', () => {
    const locals = buildCleanLitePsLocals(account, {});
    expect(locals.clpIntegrationConfig).not.toBeNull();
    const cfg = locals.clpIntegrationConfig as any;
    expect(cfg.conflictTarget).toEqual(['provider', 'externalId']);
    expect(cfg.writeColumns).toEqual(['userId', 'name', 'domain', 'employeeCount']);
  });

  it('names the FK write-key ${relationKey}ExternalId and self-FK refTable self', () => {
    const locals = buildCleanLitePsLocals(account, {});
    const fk = (locals.clpIntegrationFkResolvers as any[])[0];
    expect(fk.column).toBe('parentAccountId');
    expect(fk.writeKey).toBe('parentAccountExternalId');
    expect(fk.isSelfFk).toBe(true);
  });

  it('non-self integrated FK uses target table name + adds a parent import', () => {
    const locals = buildCleanLitePsLocals(contact, {});
    const fk = (locals.clpIntegrationFkResolvers as any[])[0];
    expect(fk.column).toBe('accountId');
    expect(fk.writeKey).toBe('accountExternalId');
    expect(fk.isSelfFk).toBe(false);
    expect(fk.refTable).toBe('accounts');
    expect(locals.clpIntegrationParentTableImports).toEqual([
      { table: 'accounts', importPath: '../accounts/account.entity' },
    ]);
  });

  it('self-FK contributes NO parent import', () => {
    const locals = buildCleanLitePsLocals(account, {});
    expect(locals.clpIntegrationParentTableImports).toEqual([]);
  });

  it('projectionColumns include id/externalId/FK/timestamps, never provider', () => {
    const locals = buildCleanLitePsLocals(account, {});
    const cfg = locals.clpIntegrationConfig as any;
    expect(cfg.projectionColumns).toEqual([
      'id', 'externalId', 'userId', 'name', 'domain', 'employeeCount',
      'parentAccountId', 'createdAt', 'updatedAt',
    ]);
    expect(cfg.projectionColumns).not.toContain('provider');
  });

  it('marks a required FK resolver strict and leaves a nullable FK opportunistic', () => {
    // strictness is sourced from the FK FIELD's `required` — NOT the
    // relationship-level `nullable` (which defaults true when undeclared).
    const belongsTo = [
      {
        field: 'account_id', camelField: 'accountId', relationKey: 'account',
        relatedTable: 'accounts', relatedEntity: 'account', isSelfFk: false,
        nullable: true, importPath: '../accounts/account.entity',
      },
      {
        field: 'parent_id', camelField: 'parentId', relationKey: 'parent',
        relatedTable: 'leads', relatedEntity: 'lead', isSelfFk: true,
        nullable: true, importPath: '../leads/lead.entity',
      },
    ];
    const fields = {
      account_id: { type: 'uuid', required: true, foreign_key: 'accounts.id' },
      parent_id: { type: 'uuid', nullable: true, foreign_key: 'leads.id' },
    };
    const surface = buildIntegrationSurface('Integrated', [], belongsTo, true, false, false, fields) as any;
    const byCol = Object.fromEntries(surface.fkResolvers.map((r: any) => [r.column, r]));
    // required, non-null FK column → strict (unresolved parent = failed item)
    expect(byCol.accountId.strict).toBe(true);
    // nullable FK (self-FK hierarchy) → opportunistic, even though the
    // relationship-level nullable would have defaulted the same way
    expect(byCol.parentId.strict).toBe(false);
  });
});

// ============================================================================
// Emitted output
// ============================================================================

describe('integrated repository emission — self-FK (account)', () => {
  const out = render(buildCleanLitePsLocals(account, {}) as Record<string, unknown>);

  it('emits TIntegrationWrite with nullable-aware fields + FK write-key', () => {
    expect(out).toContain('export interface AccountIntegrationWrite {');
    expect(out).toContain('readonly externalId: string;');
    expect(out).toContain('readonly domain: string | null;');
    expect(out).toContain('readonly employeeCount: number | null;');
    expect(out).toContain('readonly parentAccountExternalId?: string | null;');
    expect(out).toContain('readonly fields?: Record<string, unknown>;');
  });

  it('emits TIntegrationProjection omitting provider/providerMetadata', () => {
    expect(out).toContain('export interface AccountIntegrationProjection {');
    expect(out).toContain('readonly parentAccountId: string | null;');
    expect(out).toContain('readonly createdAt: Date;');
    expect(out).not.toContain('readonly provider:');
    expect(out).not.toContain('readonly providerMetadata');
  });

  it('widens the extends clause to the three-param base', () => {
    expect(out).toContain('extends IntegratedEntityRepository<');
    expect(out).toContain('AccountIntegrationWrite,');
    expect(out).toContain('AccountIntegrationProjection');
  });

  it('emits the integrationConfig literal with refTable: \'self\' (not HTML-escaped)', () => {
    expect(out).toContain("refTable: 'self'");
    expect(out).not.toContain('&#39;');
    expect(out).toContain("conflictTarget: ['provider', 'externalId']");
    expect(out).toContain('protected readonly integrationConfig: IntegrationUpsertConfig = {');
  });

  it('imports IntegrationUpsertConfig + DrizzleTx', () => {
    expect(out).toContain("import type { IntegrationUpsertConfig } from '@shared/base-classes/integration-upsert-config';");
    expect(out).toContain('DrizzleTx');
  });

  it('updates the inherited-methods comment to the now-real methods', () => {
    expect(out).toContain('integrationUpsertOne, findByExternalIdProjected, softDeleteByExternalId, integrationUpsert');
  });

  it('does NOT emit an eav override for a non-eav entity', () => {
    expect(out).not.toContain('FieldValueService');
    expect(out).not.toContain('writeCustomFields');
  });
});

describe('integrated repository emission — non-self FK + eav (contact)', () => {
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

  it('threads softDelete: true into the integrationConfig', () => {
    expect(out).toContain('softDelete: true');
  });
});

describe('non-Integrated repository emission', () => {
  const out = render(buildCleanLitePsLocals(widget, {}) as Record<string, unknown>);

  it('emits no integration surface', () => {
    expect(out).not.toContain('IntegrationWrite');
    expect(out).not.toContain('IntegrationProjection');
    expect(out).not.toContain('integrationConfig');
    expect(out).not.toContain('IntegrationUpsertConfig');
  });

  it('keeps the single-param extends', () => {
    expect(out).toContain('extends BaseRepository<Widget> {');
  });
});

// ============================================================================
// #490 — buildIntegrationSurface: delete knob + exclude_fields
// ============================================================================

describe('#490 buildIntegrationSurface — delete knob: resolveSoftDeleteBoolean', () => {
  // Import resolveSoftDeleteBoolean and test the mapping rule directly.
  // The contract test (490-sink-knobs-contract.test.ts §d) locks the full
  // two-derivation agreement; this block tests the helper in isolation.

  it('soft → true (regardless of hasSoftDelete)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const surface = buildIntegrationSurface('Integrated', [], [], false, false, false, {}, { delete: 'soft' }) as any;
    expect(surface.integrationConfig.softDelete).toBe(true);
  });

  it('tombstone → false (regardless of hasSoftDelete)', () => {
    const surface = buildIntegrationSurface('Integrated', [], [], false, false, true, {}, { delete: 'tombstone' }) as any;
    expect(surface.integrationConfig.softDelete).toBe(false);
  });

  it('noop → !!hasSoftDelete (false when no soft_delete behavior)', () => {
    const surface = buildIntegrationSurface('Integrated', [], [], false, false, false, {}, { delete: 'noop' }) as any;
    expect(surface.integrationConfig.softDelete).toBe(false);
  });

  it('noop → !!hasSoftDelete (true when soft_delete behavior present)', () => {
    const surface = buildIntegrationSurface('Integrated', [], [], false, false, true, {}, { delete: 'noop' }) as any;
    expect(surface.integrationConfig.softDelete).toBe(true);
  });

  it('absent delete knob → !!hasSoftDelete (false)', () => {
    const surface = buildIntegrationSurface('Integrated', [], [], false, false, false, {}) as any;
    expect(surface.integrationConfig.softDelete).toBe(false);
  });

  it('absent delete knob → !!hasSoftDelete (true)', () => {
    const surface = buildIntegrationSurface('Integrated', [], [], false, false, true, {}) as any;
    expect(surface.integrationConfig.softDelete).toBe(true);
  });
});

describe('#490 buildIntegrationSurface — exclude_fields: writeColumns/writeFields vs projectionColumns/projectionFields', () => {
  const fields = [
    { name: 'body', camelName: 'body', tsType: 'string', nullable: false },
    {
      name: 'conversation_external_id',
      camelName: 'conversationExternalId',
      tsType: 'string',
      nullable: true,
    },
  ];
  const policy = { exclude_fields: ['conversation_external_id'] };

  const surface = buildIntegrationSurface(
    'Integrated',
    fields,
    [],
    false,
    false,
    false,
    {},
    policy,
  ) as any;

  it('writeColumns excludes conversationExternalId', () => {
    expect(surface.integrationConfig.writeColumns).not.toContain('conversationExternalId');
  });

  it('writeFields excludes conversationExternalId', () => {
    const names = surface.writeFields.map((f: any) => f.camelName);
    expect(names).not.toContain('conversationExternalId');
  });

  it('projectionColumns retains conversationExternalId', () => {
    expect(surface.integrationConfig.projectionColumns).toContain('conversationExternalId');
  });

  it('projectionFields retains conversationExternalId', () => {
    const names = surface.projectionFields.map((f: any) => f.camelName);
    expect(names).toContain('conversationExternalId');
  });

  it('non-excluded field body remains in writeColumns and projectionColumns', () => {
    expect(surface.integrationConfig.writeColumns).toContain('body');
    expect(surface.integrationConfig.projectionColumns).toContain('body');
  });
});
