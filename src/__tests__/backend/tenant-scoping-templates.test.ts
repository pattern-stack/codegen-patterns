/**
 * TEN-1 (#585) — what `tenant_scoped: true` emits (ADR-042 §5, the backend pipeline).
 *
 * One YAML flag drives five emissions, and this file is the contract for each:
 * the nullable column, its index, the `BehaviorConfig` field, the STRICT
 * enforcement override, and the per-tenant rewrite of every uniqueness
 * constraint. It also pins the two negative cases — a `clean` project is
 * refused outright, and an entity with a `unique: true` field still emits no
 * bare single-column unique (TEN-1 §M3: the backend pipeline emits none at all, so
 * ADR-042 §5(c)'s "suppress the bare unique" step has nothing to suppress).
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import {
  buildBackendLocals,
  buildIntegrationSurface,
} from '../../../templates/entity/new/backend/entity-locals.js';

function extractBody(source: string): string {
  const lines = source.split('\n');
  if (lines[0] !== '---') return source;
  const end = lines.indexOf('---', 1);
  return end === -1 ? source : lines.slice(end + 1).join('\n');
}
import { withEntities } from './_entity-lookup';


const ENTITY_TEMPLATE = extractBody(
  readFileSync(
    resolve(import.meta.dir, '../../../templates/entity/new/backend/entity.ejs.t'),
    'utf8',
  ),
);
const REPOSITORY_TEMPLATE = extractBody(
  readFileSync(
    resolve(import.meta.dir, '../../../templates/entity/new/backend/repository.ejs.t'),
    'utf8',
  ),
);

const renderEntity = (locals: Record<string, unknown>): string =>
  ejs.render(ENTITY_TEMPLATE, locals, { rmWhitespace: false });
const renderRepository = (locals: Record<string, unknown>): string =>
  ejs.render(REPOSITORY_TEMPLATE, locals, { rmWhitespace: false });

/** A minimal tenant-scoped entity; `extra` layers on the case under test. */
const noteDefinition = (extra: Record<string, unknown> = {}) => ({
  entity: { name: 'note', plural: 'notes', table: 'notes', pattern: 'Base' },
  fields: { title: { type: 'string', required: true } },
  relationships: {},
  behaviors: ['timestamps'],
  tenant_scoped: true,
  ...extra,
});

const localsFor = (def: Record<string, unknown>) => buildBackendLocals(def, withEntities());

// ============================================================================
// (a) The column
// ============================================================================

describe('tenant_scoped — the tenant_id column', () => {
  it('emits a NULLABLE uuid tenant_id', () => {
    const out = renderEntity(localsFor(noteDefinition()));
    expect(out).toContain("tenantId: uuid('tenant_id'),");
    // Nullable on purpose: flipping the flag on a live table must be an
    // additive ADD COLUMN, tightened to NOT NULL by the host after backfill.
    expect(out).not.toContain("uuid('tenant_id').notNull()");
  });

  it('emits NO .references() — the tenants table is host-owned (#636)', () => {
    const out = renderEntity(localsFor(noteDefinition()));
    expect(out).not.toMatch(/tenant_id'\)\.references/);
  });

  it('emits nothing at all when the flag is absent', () => {
    const def = noteDefinition();
    delete (def as Record<string, unknown>)['tenant_scoped'];
    const out = renderEntity(localsFor(def));
    expect(out).not.toContain('tenant_id');
  });

  it('indexes tenant_id — every scoped read filters on it', () => {
    const out = renderEntity(localsFor(noteDefinition()));
    expect(out).toContain("index('notes_tenant_id_idx').on(t.tenantId)");
    expect(out).toMatch(/import \{[\s\S]*\bindex,/);
  });
});

// ============================================================================
// (b) The repository
// ============================================================================

describe('tenant_scoped — the repository', () => {
  it('emits tenantScoped: true in the BehaviorConfig literal', () => {
    const out = renderRepository(localsFor(noteDefinition()));
    expect(out).toContain('tenantScoped: true');
  });

  it('emits scopeEnforcement: strict — there is no lenient opt-down', () => {
    const out = renderRepository(localsFor(noteDefinition()));
    expect(out).toContain("protected override readonly scopeEnforcement = 'strict' as const;");
  });

  it('emits the literal even for an otherwise behaviorless entity', () => {
    // The guard used to fire on timestamps/softDelete/userTracking only, which
    // would have dropped `tenantScoped: true` on the floor for this entity.
    const def = noteDefinition({ behaviors: [] });
    const out = renderRepository(localsFor(def));
    expect(out).toContain('protected override readonly behaviors: BehaviorConfig');
    expect(out).toContain('tenantScoped: true');
    expect(out).toContain(
      "import type { BehaviorConfig } from '@shared/base-classes/base-repository';",
    );
  });

  it('a non-tenant entity states tenantScoped: false and stays lenient', () => {
    const def = noteDefinition({ tenant_scoped: false });
    const out = renderRepository(localsFor(def));
    expect(out).toContain('tenantScoped: false');
    expect(out).not.toContain('scopeEnforcement');
  });
});

// ============================================================================
// (c) Uniqueness — per tenant, not global
// ============================================================================

describe('tenant_scoped — uniqueness is per tenant', () => {
  it('prefixes tenant_id onto every unique_indexes entry', () => {
    const def = noteDefinition({
      fields: {
        title: { type: 'string', required: true },
        slug: { type: 'string', required: true },
      },
      unique_indexes: [{ fields: ['title', 'slug'] }],
    });
    const out = renderEntity(localsFor(def));
    expect(out).toContain(
      "uniqueIndex('notes_tenant_id_title_slug_uniq').on(t.tenantId, t.title, t.slug)",
    );
  });

  it('preserves an author-supplied index name while still prefixing the column', () => {
    const def = noteDefinition({
      fields: {
        title: { type: 'string', required: true },
        slug: { type: 'string', required: true },
      },
      unique_indexes: [{ fields: ['title', 'slug'], name: 'my_constraint' }],
    });
    const out = renderEntity(localsFor(def));
    expect(out).toContain("uniqueIndex('my_constraint').on(t.tenantId, t.title, t.slug)");
  });

  it('leaves unique_indexes alone when the entity is not tenant-scoped', () => {
    const def = noteDefinition({
      tenant_scoped: false,
      fields: {
        title: { type: 'string', required: true },
        slug: { type: 'string', required: true },
      },
      unique_indexes: [{ fields: ['title', 'slug'] }],
    });
    const out = renderEntity(localsFor(def));
    expect(out).toContain("uniqueIndex('notes_title_slug_uniq').on(t.title, t.slug)");
    expect(out).not.toContain('tenantId');
  });

  it('emits NO bare single-column unique for a `unique: true` field (§M3)', () => {
    const def = noteDefinition({
      fields: { title: { type: 'string', required: true, unique: true } },
    });
    const out = renderEntity(localsFor(def));
    // the backend pipeline emits no single-column uniqueness at all, so there is
    // nothing for the tenant prefix to rewrite — and, critically, no global
    // unique that would forbid two tenants holding the same title.
    expect(out).not.toContain('.unique()');
    expect(out).not.toContain("uniqueIndex('notes_title_uniq')");
  });
});

// ============================================================================
// (d) external_id_tracking — the ON CONFLICT target
// ============================================================================

describe('tenant_scoped + external_id_tracking', () => {
  const integratedDef = (tenantScoped: boolean) => ({
    entity: { name: 'lead', plural: 'leads', table: 'leads', pattern: 'Integrated' },
    fields: { name: { type: 'string', required: true } },
    relationships: {},
    behaviors: ['timestamps', 'external_id_tracking'],
    tenant_scoped: tenantScoped,
  });

  it('emits a per-tenant unique CONSTRAINT with NULLS NOT DISTINCT', () => {
    const out = renderEntity(localsFor(integratedDef(true)));
    expect(out).toContain(
      "unique('uq_leads_tenant_provider_external_id')" +
        '.on(t.tenantId, t.provider, t.externalId).nullsNotDistinct()',
    );
    // `unique(...)`, not `uniqueIndex(...)`: only the constraint builder
    // carries `.nullsNotDistinct()` on drizzle 1.0.0-rc.4, and without it a
    // null-tenant ON CONFLICT never fires — the upsert would insert duplicates
    // instead of updating.
    expect(out).not.toContain("uniqueIndex('uq_leads_tenant_provider_external_id')");
    expect(out).toMatch(/import \{[\s\S]*\bunique,/);
  });

  it('keeps the plain (provider, external_id) uniqueIndex when not tenant-scoped', () => {
    const out = renderEntity(localsFor(integratedDef(false)));
    expect(out).toContain(
      "uniqueIndex('uq_leads_provider_external_id').on(t.provider, t.externalId)",
    );
    expect(out).not.toContain('nullsNotDistinct');
  });

  it('the generated integrationConfig declares the tenant-prefixed conflict target', () => {
    // Charter I1: the runtime reads the declared target rather than
    // introspecting the table to discover the entity is tenant-scoped.
    const scoped = buildIntegrationSurface(
      'Integrated', [], [], true, false, false, {}, undefined, true,
    ) as { integrationConfig: { conflictTarget: string[] } };
    expect(scoped.integrationConfig.conflictTarget).toEqual([
      'tenantId',
      'provider',
      'externalId',
    ]);

    const unscoped = buildIntegrationSurface(
      'Integrated', [], [], true, false, false, {}, undefined, false,
    ) as { integrationConfig: { conflictTarget: string[] } };
    expect(unscoped.integrationConfig.conflictTarget).toEqual(['provider', 'externalId']);
  });

  it('the emitted repository literal carries the tenant-prefixed target', () => {
    const out = renderRepository(localsFor(integratedDef(true)));
    expect(out).toContain("conflictTarget: ['tenantId', 'provider', 'externalId']");
  });
});

// ============================================================================
// (e) The refusals — never emit a repository that claims isolation it lacks
// ============================================================================

describe('tenant_scoped — generation-time guards', () => {
  it('refuses eav_value_table (an author-declared ON CONFLICT target)', () => {
    expect(() =>
      localsFor(
        noteDefinition({
          eav_value_table: true,
          eav_definition_table: 'field_definition',
        }),
      ),
    ).toThrow(/tenant_scoped: true is not supported with eav_value_table: true/);
  });

  it('the junction schema cannot declare it at all', async () => {
    // Junctions are out of scope in v1 (TEN-1 §11). `.strict()` is what makes
    // that true rather than merely intended; asserted so it stays true.
    //
    // The assertion is differential ON PURPOSE: a fixture that fails for some
    // unrelated reason would "pass" this test while proving nothing. So the
    // same document is parsed twice — valid without the key, rejected with it.
    const { JunctionDefinitionSchema } = await import(
      '../../schema/junction-definition.schema'
    );
    const { parse: parseYaml } = await import('yaml');
    const valid = parseYaml(
      readFileSync(
        resolve(import.meta.dir, '../../../test/fixtures/junctions/opportunity_contact.yaml'),
        'utf8',
      ),
    ) as Record<string, unknown>;

    expect(JunctionDefinitionSchema.safeParse(valid).success).toBe(true);

    const withFlag = JunctionDefinitionSchema.safeParse({
      ...valid,
      tenant_scoped: true,
    });
    expect(withFlag.success).toBe(false);
    expect(JSON.stringify(withFlag.error?.issues)).toContain('tenant_scoped');
  });
});
