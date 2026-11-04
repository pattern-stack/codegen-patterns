/**
 * Template rendering tests for backend Drizzle column/table feature
 * emission — the cohesive cluster of "YAML metadata read but not emitted" bugs:
 *
 *   #345 — field `default:` → `.default(...)` / `.defaultNow()` on the column
 *   #354 — field `foreign_key: <table>.<col>` → `.references((): AnyPgColumn => ...)` + import
 *   #355 — field `index: true` → `index('<table>_<col>_idx').on(t.<col>)` in the
 *          pgTable extra-config callback + `index` import
 *   #356 — top-level `unique_indexes:` → `uniqueIndex(...).on(...)` + import
 *   #511 — field `unique: true` → a single-column `uniqueIndex(...)` through the same builder
 *   #784 — `unique_indexes:` shapes: single field, `where:` (partial), `nulls_not_distinct:`
 *
 * These mirror the rendering harness in entity-fk-template.test.ts (render the
 * EJS body with locals from buildBackendLocals).
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { withEntities } from './_entity-lookup';

const ENTITY_TEMPLATE = readFileSync(
  resolve(import.meta.dir, '../../../templates/entity/new/backend/entity.ejs.t'),
  'utf8',
);

function extractBody(source: string): string {
  const lines = source.split('\n');
  if (lines[0] !== '---') return source;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return source;
  return lines.slice(end + 1).join('\n');
}

function render(
  definition: Record<string, unknown>,
  baseLocals: Record<string, unknown> = {},
): {
  output: string;
  locals: Record<string, unknown>;
} {
  const locals = buildBackendLocals(definition, withEntities(baseLocals)) as Record<
    string,
    unknown
  >;
  const output = ejs.render(extractBody(ENTITY_TEMPLATE), locals, { rmWhitespace: false });
  return { output, locals };
}

// ============================================================================
// #345 — column defaults
// ============================================================================

describe('column defaults (#345)', () => {
  const definition = {
    entity: { name: 'conversation', plural: 'conversations', table: 'conversations', pattern: 'Base' },
    fields: {
      state: { type: 'enum', choices: ['created', 'active', 'completed'], required: true, default: 'created' },
      exchange_count: { type: 'integer', required: true, default: 0 },
      role_name: { type: 'string', required: true, default: 'user' },
      is_archived: { type: 'boolean', default: false },
      score: { type: 'decimal', default: 0 },
      started_at: { type: 'datetime', default: 'now' },
    },
    relationships: {},
    behaviors: [],
  };

  it('emits .default(literal) on an enum column', () => {
    const { output } = render(definition);
    expect(output).toContain(".default('created')");
    // The enum const is namespaced by entity (conversation_state) — the column
    // name stays the bare field name.
    expect(output).toContain("conversationStateEnum('state').notNull().default('created')");
  });

  it('emits a bare numeric default on an integer column', () => {
    const { output } = render(definition);
    expect(output).toContain("integer('exchange_count').notNull().default(0)");
  });

  it('emits a quoted string default on a text column', () => {
    const { output } = render(definition);
    expect(output).toContain("text('role_name').notNull().default('user')");
  });

  it('emits a bare boolean default', () => {
    const { output } = render(definition);
    expect(output).toContain("boolean('is_archived').default(false)");
  });

  it('quotes a numeric (decimal) default — Drizzle numeric is string-typed', () => {
    const { output } = render(definition);
    expect(output).toContain("numeric('score').default('0')");
  });

  it("maps the `now` sentinel on a datetime column to .defaultNow()", () => {
    const { output } = render(definition);
    expect(output).toContain(
      "timestamp('started_at', { withTimezone: true, mode: 'date' }).defaultNow()",
    );
  });

  it('emits no default suffix when no default is declared', () => {
    const { output } = render({
      entity: { name: 'widget', plural: 'widgets', table: 'widgets', pattern: 'Base' },
      fields: { label: { type: 'string', required: true } },
      relationships: {},
      behaviors: [],
    });
    expect(output).toContain("label: text('label').notNull(),");
    expect(output).not.toContain('.default(');
  });
});

// ============================================================================
// #354 — field-level foreign_key
// ============================================================================

describe('field-level foreign_key (#354)', () => {
  const definition = {
    entity: { name: 'tool_call', plural: 'tool_calls', table: 'tool_calls', pattern: 'Base' },
    fields: {
      conversation_id: { type: 'uuid', required: true, foreign_key: 'conversations.id' },
      name: { type: 'string', required: true },
    },
    relationships: {},
    behaviors: [],
  };

  it('appends .references((): AnyPgColumn => <table>.<col>) to the FK column chain', () => {
    const { output } = render(definition);
    expect(output).toContain(
      "conversationId: uuid('conversation_id').notNull().references((): AnyPgColumn => conversations.id),",
    );
  });

  it('imports the referenced table from the singularized entity path', () => {
    const { output } = render(definition);
    expect(output).toContain("import { conversations } from '../conversations/conversation.entity';");
  });

  it('omits .notNull() but still references on a nullable FK column', () => {
    const { output } = render({
      entity: { name: 'tool_call', plural: 'tool_calls', table: 'tool_calls', pattern: 'Base' },
      fields: {
        conversation_id: { type: 'uuid', foreign_key: 'conversations.id' },
      },
      relationships: {},
      behaviors: [],
    });
    expect(output).toContain("conversationId: uuid('conversation_id').references((): AnyPgColumn => conversations.id),");
    expect(output).not.toContain("uuid('conversation_id').notNull()");
  });

  it('uses the AnyPgColumn annotation + no self-import for a self-referential FK', () => {
    const { output, locals } = render({
      entity: { name: 'conversation', plural: 'conversations', table: 'conversations', pattern: 'Base' },
      fields: {
        branched_from_id: { type: 'uuid', foreign_key: 'conversations.id' },
      },
      relationships: {},
      behaviors: [],
    });
    expect(output).toContain(
      "branchedFromId: uuid('branched_from_id').references((): AnyPgColumn => conversations.id),",
    );
    expect(output).toContain('type AnyPgColumn');
    expect(locals.hasFk).toBe(true);
    // No self-import.
    expect(output).not.toContain("import { conversations } from");
  });
});

// ============================================================================
// #355 — field-level index: true
// ============================================================================

describe('single-column index (#355)', () => {
  const definition = {
    entity: { name: 'conversation', plural: 'conversations', table: 'conversations', pattern: 'Base' },
    fields: {
      role_name: { type: 'string', required: true, index: true },
      state: { type: 'enum', choices: ['created', 'active'], required: true },
    },
    relationships: {},
    behaviors: [],
  };

  it('emits a named index in the pgTable extra-config callback', () => {
    const { output } = render(definition);
    expect(output).toMatch(/\},\s*\(t\) => \[/);
    expect(output).toContain("index('conversations_role_name_idx').on(t.roleName)");
  });

  it('imports index from drizzle-orm/pg-core', () => {
    const { output, locals } = render(definition);
    expect(locals.drizzleImports).toContain('index');
    expect(output).toContain('index,');
  });

  it('indexes a field-level FK column that is also marked index: true', () => {
    const { output } = render({
      entity: { name: 'tool_call', plural: 'tool_calls', table: 'tool_calls', pattern: 'Base' },
      fields: {
        conversation_id: { type: 'uuid', required: true, foreign_key: 'conversations.id', index: true },
      },
      relationships: {},
      behaviors: [],
    });
    // Both the reference AND the index land.
    expect(output).toContain(".references((): AnyPgColumn => conversations.id)");
    expect(output).toContain("index('tool_calls_conversation_id_idx').on(t.conversationId)");
  });

  it('emits no callback or index import when no field declares index', () => {
    const { output, locals } = render({
      entity: { name: 'widget', plural: 'widgets', table: 'widgets', pattern: 'Base' },
      fields: { label: { type: 'string', required: true } },
      relationships: {},
      behaviors: [],
    });
    expect(locals.drizzleImports).not.toContain('index');
    expect(output).not.toMatch(/\},\s*\(t\) => \[/);
  });
});

// ============================================================================
// #356 — composite unique_indexes
// ============================================================================

describe('composite unique_indexes (#356)', () => {
  const definition = {
    entity: { name: 'message', plural: 'messages', table: 'messages', pattern: 'Base' },
    fields: {
      conversation_id: { type: 'uuid', required: true },
      sequence: { type: 'integer', required: true },
      body: { type: 'string', required: true },
    },
    relationships: {},
    behaviors: [],
    unique_indexes: [{ fields: ['conversation_id', 'sequence'] }],
  };

  it('emits uniqueIndex over the camelCased columns with the default name', () => {
    const { output } = render(definition);
    expect(output).toContain(
      "uniqueIndex('messages_conversation_id_sequence_uniq').on(t.conversationId, t.sequence)",
    );
  });

  it('honors an explicit index name', () => {
    const { output } = render({
      ...definition,
      unique_indexes: [
        { fields: ['conversation_id', 'sequence'], name: 'messages_conversation_sequence_uniq' },
      ],
    });
    expect(output).toContain(
      "uniqueIndex('messages_conversation_sequence_uniq').on(t.conversationId, t.sequence)",
    );
  });

  it('imports uniqueIndex from drizzle-orm/pg-core', () => {
    const { output, locals } = render(definition);
    expect(locals.drizzleImports).toContain('uniqueIndex');
    expect(output).toContain('uniqueIndex,');
  });

  it('coexists with single-column indexes in one extra-config callback', () => {
    const { output } = render({
      ...definition,
      fields: {
        conversation_id: { type: 'uuid', required: true, index: true },
        sequence: { type: 'integer', required: true },
        body: { type: 'string', required: true },
      },
    });
    // exactly one (t) => [ callback
    const matches = output.match(/\(t\) => \[/g) ?? [];
    expect(matches.length).toBe(1);
    expect(output).toContain("index('messages_conversation_id_idx').on(t.conversationId)");
    expect(output).toContain(
      "uniqueIndex('messages_conversation_id_sequence_uniq').on(t.conversationId, t.sequence)",
    );
  });
});


// ============================================================================
// #511 — field-level unique: true
// ============================================================================

describe('field-level unique (#511)', () => {
  const seasonDef = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    entity: { name: 'season', plural: 'seasons', table: 'seasons', pattern: 'Base' },
    fields,
    relationships: {},
    behaviors: [],
    ...extra,
  });
  const fkDef = (fieldExtra: Record<string, unknown>) => ({
    entity: { name: 'season', plural: 'seasons', table: 'seasons', pattern: 'Base' },
    fields: { account_id: { type: 'uuid', required: true, ...fieldExtra } },
    relationships: {
      account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
    },
    behaviors: [],
  });

  it('emits a uniqueIndex for a scalar unique: true field, and no .unique() chain', () => {
    const { output, locals } = render(seasonDef({ label: { type: 'string', required: true, unique: true } }));
    expect(output).toContain("uniqueIndex('seasons_label_uniq').on(t.label)");
    expect(locals.drizzleImports).toContain('uniqueIndex');
    expect(output).not.toContain('.unique()');
  });

  it('covers a belongs_to FK column declared in fields: with unique: true', () => {
    const { output } = render(fkDef({ unique: true }));
    expect(output).toContain("uniqueIndex('seasons_account_id_uniq').on(t.accountId)");
  });

  it('drops the plain index when unique + index on a non-tenant scalar', () => {
    const { output, locals } = render(
      seasonDef({ label: { type: 'string', required: true, unique: true, index: true } }),
    );
    expect(output).toContain("uniqueIndex('seasons_label_uniq').on(t.label)");
    expect(output).not.toContain('seasons_label_idx');
    expect(locals.drizzleImports).not.toContain('index');
  });

  it('drops the plain index when unique + index on a non-tenant FK', () => {
    const { output, locals } = render(fkDef({ unique: true, index: true }));
    expect(output).toContain("uniqueIndex('seasons_account_id_uniq').on(t.accountId)");
    expect(output).not.toContain('seasons_account_id_idx');
    expect(locals.drizzleImports).not.toContain('index');
  });

  it('keeps an index: true on a different field', () => {
    const { output } = render(
      seasonDef({
        label: { type: 'string', required: true, unique: true, index: true },
        code: { type: 'string', required: true, index: true },
      }),
    );
    expect(output).toContain("index('seasons_code_idx').on(t.code)");
    expect(output).not.toContain('seasons_label_idx');
  });

  it('orders field uniques (fields: order) before unique_indexes: in one callback', () => {
    const { output } = render(
      seasonDef(
        {
          a: { type: 'string', required: true, unique: true },
          b: { type: 'string', required: true },
          c: { type: 'string', required: true, unique: true },
        },
        { unique_indexes: [{ fields: ['b', 'c'] }] },
      ),
    );
    expect((output.match(/\(t\) => \[/g) ?? []).length).toBe(1);
    const ia = output.indexOf("'seasons_a_uniq'");
    const ic = output.indexOf("'seasons_c_uniq'");
    const ibc = output.indexOf("'seasons_b_c_uniq'");
    expect(ia).toBeGreaterThan(-1);
    expect(ia).toBeLessThan(ic);
    expect(ic).toBeLessThan(ibc);
  });

  it('emits nothing extra for id: { unique: true }', () => {
    const { output } = render(
      seasonDef({ id: { type: 'uuid', unique: true }, label: { type: 'string', required: true } }),
    );
    expect(output).not.toContain('uniqueIndex');
    expect(output).not.toContain('seasons_id_uniq');
  });
});

// ============================================================================
// #636 — a field FK to a HOST-OWNED table
// ============================================================================

/**
 * A `foreign_key:` may legitimately name a table no entity YAML generates — a
 * tenants table, a users table from an auth provider. The host owns it.
 *
 * Decided here (#636, option 2, made explicit): codegen emits a DB-level FK
 * only for tables it generates. A host-owned target emits a PLAIN column, with
 * no `.references()` and no import, because the only alternatives are an import
 * of a module codegen never writes (the pre-#630 behaviour, which cannot
 * resolve) or a generation error that forbids a legitimate declaration.
 * Referential integrity for a host-owned table is the host's, in its own
 * migration. `tenant_scoped: true` emits exactly this shape for `tenant_id`.
 *
 * `ownedTableNames` is supplied by `prompt.js` from the entities directory —
 * read from the YAMLs, never from generated output, so a two-pass run gives the
 * same answer on both passes (charter I1).
 */
describe('field-level foreign_key to a host-owned table (#636)', () => {
  const definition = {
    entity: { name: 'note', plural: 'notes', table: 'notes', pattern: 'Base' },
    fields: {
      tenant_id: { type: 'uuid', required: true, foreign_key: 'tenants.id', index: true },
      conversation_id: { type: 'uuid', required: true, foreign_key: 'conversations.id' },
      title: { type: 'string', required: true },
    },
    relationships: {},
    behaviors: [],
  };

  // Only `conversations` is generated by an entity YAML; `tenants` is the host's.
  const ownedTableNames = ['notes', 'conversations'];

  it('emits the host-owned column PLAIN — no .references()', () => {
    const { output } = render(definition, { ownedTableNames });
    expect(output).toContain("tenantId: uuid('tenant_id').notNull(),");
    expect(output).not.toMatch(/tenant_id'\)[^,\n]*\.references/);
  });

  it('emits no import for the host-owned table', () => {
    const { output, locals } = render(definition, { ownedTableNames });
    expect(output).not.toContain('tenant.entity');
    expect(locals.fieldFkImports).toEqual([
      // `conversations` only — the host-owned target contributed nothing.
      { relatedTable: 'conversations', importPath: '../conversations/conversation.entity' },
    ]);
  });

  it('still emits the FK for a table codegen DOES own', () => {
    const { output } = render(definition, { ownedTableNames });
    expect(output).toContain(
      "conversationId: uuid('conversation_id').notNull().references((): AnyPgColumn => conversations.id),",
    );
    expect(output).toContain(
      "import { conversations } from '../conversations/conversation.entity';",
    );
  });

  it('still honours index: true on the host-owned column', () => {
    // The host-owned branch must not skip the rest of the field's features —
    // a reference to an external table is usually exactly what you index.
    const { output } = render(definition, { ownedTableNames });
    expect(output).toContain("index('notes_tenant_id_idx').on(t.tenantId)");
  });

  it('without an ownedTableNames list an unresolvable target is an error', () => {
    // #636 treated a no-list caller as "every target is owned"; NAME-0 then made
    // the import come from the target's own YAML, so "owned" now means a YAML
    // declares it. With no list and no YAML for `tenants` the two rules meet
    // here, and NAME-0's wins: the alternative is an import of a module codegen
    // never writes. `prompt.js` always passes the list, so real generation still
    // gets the host-owned plain column proved above.
    expect(() => render(definition)).toThrow(
      /the table 'tenants' is not owned by any entity YAML/,
    );
  });
});

// ============================================================================
// #736 / #613 — column nullability by the one rule (field-nullability.ts)
// ============================================================================

describe('column nullability (#736, #613)', () => {
  const definition = {
    entity: { name: 'stat_line', plural: 'stat_lines', table: 'stat_lines', pattern: 'Base' },
    fields: {
      // The #736 repro: NOT NULL with a DB default, optional on create.
      pts: { type: 'integer', required: false, nullable: false, default: 0 },
      // Neither declared: a nullable column, and the read type says so.
      ast: { type: 'integer' },
      reb: { type: 'integer', nullable: true },
      player_name: { type: 'string', required: true },
    },
    relationships: {},
    behaviors: [],
  };

  type ZodField = { camelName: string; zodChainCreate?: string; zodChainOutput?: string };
  const byName = (list: unknown, key: 'zodChainCreate' | 'zodChainOutput') =>
    Object.fromEntries((list as ZodField[]).map((f) => [f.camelName, f[key]]));

  it('required: false, nullable: false, default: → NOT NULL with the default', () => {
    const { output } = render(definition);
    expect(output).toContain("pts: integer('pts').notNull().default(0),");
  });

  it('the other declarations keep their columns', () => {
    const { output } = render(definition);
    expect(output).toContain("ast: integer('ast'),");
    expect(output).toContain("reb: integer('reb'),");
    expect(output).toContain("playerName: text('player_name').notNull(),");
  });

  it('a NOT NULL column with a default is optional on create and non-null on read', () => {
    const { locals } = render(definition);
    expect(byName(locals.createDtoFields, 'zodChainCreate').pts).toBe('z.number().int().optional()');
    expect(byName(locals.outputDtoFields, 'zodChainOutput').pts).toBe('z.number().int()');
  });

  it('an undeclared nullable column reads as nullable, matching its column', () => {
    const { locals } = render(definition);
    expect(byName(locals.createDtoFields, 'zodChainCreate').ast).toBe('z.number().int().nullable().optional()');
    expect(byName(locals.outputDtoFields, 'zodChainOutput').ast).toBe('z.number().int().nullable()');
  });

  it('a belongs_to FK declared nullable: false with a default is NOT NULL', () => {
    const { output } = render({
      entity: { name: 'note', plural: 'notes', table: 'notes', pattern: 'Base' },
      fields: {
        conversation_id: {
          type: 'uuid',
          nullable: false,
          default: '00000000-0000-0000-0000-000000000000',
        },
      },
      relationships: {
        conversation: { type: 'belongs_to', target: 'conversation', foreign_key: 'conversation_id' },
      },
      behaviors: [],
    });
    expect(output).toContain("conversationId: uuid('conversation_id').notNull()");
  });
});


// ============================================================================
// #784 — unique_indexes shapes
// ============================================================================

describe('unique_indexes shapes (#784)', () => {
  const msgDef = (unique_indexes: unknown[], extra: Record<string, unknown> = {}) => ({
    entity: { name: 'message', plural: 'messages', table: 'messages', pattern: 'Base' },
    fields: {
      conversation_id: { type: 'uuid', required: true },
      sequence: { type: 'integer', required: true },
      status: { type: 'string', required: true },
    },
    relationships: {},
    behaviors: [],
    unique_indexes,
    ...extra,
  });

  it('single field, non-tenant', () => {
    const { output } = render(msgDef([{ fields: ['conversation_id'] }]));
    expect(output).toContain("uniqueIndex('messages_conversation_id_uniq').on(t.conversationId)");
  });

  it('explicit NULLS NOT DISTINCT, non-tenant; imports by use', () => {
    const { output, locals } = render(
      msgDef([{ fields: ['conversation_id', 'sequence'], nulls_not_distinct: true }]),
    );
    expect(output).toContain(
      "unique('messages_conversation_id_sequence_uniq').on(t.conversationId, t.sequence).nullsNotDistinct()",
    );
    expect(locals.drizzleImports).toContain('unique');
    expect(locals.drizzleImports).not.toContain('uniqueIndex');
  });

  it('partial entry renders sql and imports it', () => {
    const { output } = render(
      msgDef([{ fields: ['conversation_id'], where: "status = 'open'", name: 'messages_open_uniq' }]),
    );
    expect(output).toContain(
      "uniqueIndex('messages_open_uniq').on(t.conversationId).where(sql`${t.status} = 'open'`)",
    );
    expect(output).toContain("import { sql, type InferSelectModel } from 'drizzle-orm';");
  });

  it('no partial entry leaves the drizzle-orm import untouched', () => {
    const { output } = render(msgDef([{ fields: ['conversation_id'] }]));
    expect(output).toContain("import { type InferSelectModel } from 'drizzle-orm';");
  });

  it('rewrites through the column map: FK column, soft_delete column, absent behavior column', () => {
    const fk = render(
      msgDef([{ fields: ['sequence'], where: 'account_id IS NOT NULL', name: 'm_fk_uniq' }], {
        fields: {
          account_id: { type: 'uuid', required: false },
          sequence: { type: 'integer', required: true },
        },
        relationships: {
          account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
        },
      }),
    );
    expect(fk.output).toContain('${t.accountId} IS NOT NULL');
    const sd = render(
      msgDef([{ fields: ['sequence'], where: 'deleted_at IS NULL', name: 'm_sd_uniq' }], {
        behaviors: ['soft_delete'],
      }),
    );
    expect(sd.output).toContain('${t.deletedAt} IS NULL');
    const none = render(
      msgDef([{ fields: ['sequence'], where: 'deleted_at IS NULL', name: 'm_none_uniq' }]),
    );
    expect(none.output).toContain('sql`deleted_at IS NULL`');
  });

  it('C1: an unknown field throws, naming the entry, the name and the columns', () => {
    expect(() => render(msgDef([{ fields: ['nope'] }]))).toThrow(
      /unique_indexes\[0\].*'nope'.*conversation_id/s,
    );
  });

  it('C2: a repeated field throws', () => {
    expect(() => render(msgDef([{ fields: ['sequence', 'sequence'] }]))).toThrow(/listed twice/);
  });

  it('C3: two entries with one name throw; an author name equal to a field index name throws', () => {
    expect(() =>
      render(msgDef([{ fields: ['sequence'], name: 'dup' }, { fields: ['status'], name: 'dup' }])),
    ).toThrow(/'dup'.*unique_indexes\[0\].*unique_indexes\[1\]/s);
    expect(() =>
      render(
        msgDef([{ fields: ['sequence'], name: 'messages_status_idx' }], {
          fields: {
            conversation_id: { type: 'uuid', required: true },
            sequence: { type: 'integer', required: true },
            status: { type: 'string', required: true, index: true },
          },
        }),
      ),
    ).toThrow(/messages_status_idx/);
  });

  it('C4: field unique + the same unique_indexes entry throws, naming both', () => {
    expect(() =>
      render(
        msgDef([{ fields: ['sequence'] }], {
          fields: {
            conversation_id: { type: 'uuid', required: true },
            sequence: { type: 'integer', required: true, unique: true },
            status: { type: 'string', required: true },
          },
        }),
      ),
    ).toThrow(/field 'sequence' \(unique: true\).*unique_indexes\[0\]/s);
    expect(() =>
      render(
        msgDef([{ fields: ['sequence', 'status'] }, { fields: ['status', 'sequence'], name: 'other' }]),
      ),
    ).toThrow(/same unique/);
  });

  it('C4: two partial entries over one field with different names pass', () => {
    const { output } = render(
      msgDef([
        { fields: ['conversation_id'], where: "status = 'draft'", name: 'm_draft_uniq' },
        { fields: ['conversation_id'], where: "status = 'published'", name: 'm_pub_uniq' },
      ]),
    );
    expect(output).toContain("uniqueIndex('m_draft_uniq')");
    expect(output).toContain("uniqueIndex('m_pub_uniq')");
  });

  it('nulls_not_distinct: false on a non-tenant entry renders the plain uniqueIndex', () => {
    const { output } = render(msgDef([{ fields: ['sequence'], nulls_not_distinct: false }]));
    expect(output).toContain("uniqueIndex('messages_sequence_uniq').on(t.sequence)");
    expect(output).not.toContain('nullsNotDistinct');
  });

  it('a where scanner error names the entity and the entry', () => {
    expect(() =>
      render(msgDef([{ fields: ['sequence'], where: 'sequence > 0; drop', name: 'x_uniq' }])),
    ).toThrow(/'message' unique_indexes\[0\] where: ';' at offset/);
  });

  it('tableColumns equals the rendered pgTable column block', () => {
    const def = {
      entity: { name: 'lead', plural: 'leads', table: 'leads', pattern: 'Integrated' },
      fields: {
        account_id: { type: 'uuid', required: true },
        owner_ref: { type: 'uuid', foreign_key: 'accounts.id' },
        name: { type: 'string', required: true },
      },
      relationships: {
        account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
      },
      behaviors: ['timestamps', 'soft_delete'],
      tenant_scoped: true,
    };
    const { output, locals } = render(def);
    const rendered = [...output.matchAll(/^ {4}(\w+): \w+\('(\w+)'/gm)].map((m) => `${m[2]}:${m[1]}`);
    const mapped = (locals.tableColumns as Array<{ column: string; prop: string }>).map(
      (c) => `${c.column}:${c.prop}`,
    );
    expect([...mapped].sort()).toEqual([...rendered].sort());
  });
});

// ============================================================================
// #796 — timestamptz columns
// ============================================================================

describe('timestamptz columns (#796)', () => {
  const TZ = "{ withTimezone: true, mode: 'date' }";
  const definition = {
    entity: { name: 'appointment', plural: 'appointments', table: 'appointments', pattern: 'Base' },
    fields: {
      starts_at: { type: 'datetime', required: true },
      reminded_at: { type: 'datetime', default: 'now' },
      closed_at: { type: 'datetime' },
      opens_at: { type: 'datetime', timezone: false },
    },
    behaviors: ['timestamps', 'soft_delete'],
  };

  it('a datetime field is timestamptz, with notNull and defaultNow suffixes after it', () => {
    const { output } = render(definition);
    expect(output).toContain(`startsAt: timestamp('starts_at', ${TZ}).notNull()`);
    expect(output).toContain(`remindedAt: timestamp('reminded_at', ${TZ}).defaultNow()`);
    expect(output).toContain(`closedAt: timestamp('closed_at', ${TZ}),`);
  });

  it('timezone: false is a bare wall-clock timestamp', () => {
    const { output } = render(definition);
    expect(output).toContain("opensAt: timestamp('opens_at'),");
  });

  it('timestamps and soft_delete columns are timestamptz', () => {
    const { output } = render(definition);
    expect(output).toContain(`createdAt: timestamp('created_at', ${TZ}).notNull().defaultNow()`);
    expect(output).toContain(`updatedAt: timestamp('updated_at', ${TZ}).notNull().defaultNow()`);
    expect(output).toContain(`deletedAt: timestamp('deleted_at', ${TZ}),`);
  });

  it('no bare timestamp call remains except the declared opt-out', () => {
    const { output } = render(definition);
    expect([...output.matchAll(/timestamp\('(\w+)'\)/g)].map((m) => m[1])).toEqual(['opens_at']);
  });
});
