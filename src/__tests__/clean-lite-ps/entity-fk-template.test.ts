/**
 * Template rendering tests for clean-lite-ps entity FK emission (issue #34)
 * and soft-delete warning comments (issue #41).
 *
 * Verifies that:
 *   - belongs_to relations emit `.references(() => parentTable.id, { onDelete: '...' })`
 *   - Default on_delete is 'restrict' when not specified in YAML
 *   - All four on_delete values are correctly mapped from YAML snake_case to Drizzle SQL form
 *   - A soft-delete warning comment is emitted when the entity has soft_delete behavior
 *   - No warning comment is emitted when the entity does not have soft_delete behavior
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

/**
 * Strip the Hygen front-matter (the `---` block at the top) so we render
 * only the body, matching what Hygen itself does before handing to EJS.
 */
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

function render(locals: Record<string, unknown>): string {
  return ejs.render(extractBody(ENTITY_TEMPLATE), locals, { rmWhitespace: false });
}

const EMPTY_BASE_LOCALS = {};

// ============================================================================
// Fixture: message entity (belongs_to conversation, cascade on hard-delete)
// ============================================================================

const messageDefinitionCascade = {
  entity: { name: 'message', plural: 'messages', table: 'messages', pattern: 'Base' },
  fields: {
    body: { type: 'string', required: true },
  },
  relationships: {
    conversation: {
      type: 'belongs_to',
      target: 'conversation',
      foreign_key: 'conversation_id',
      nullable: false,
      on_delete: 'cascade',
    },
  },
  behaviors: [],
};

// ============================================================================
// Fixture: message entity with soft_delete and cascade (triggers #41 warning)
// ============================================================================

const messageDefinitionSoftDeleteCascade = {
  ...messageDefinitionCascade,
  behaviors: ['timestamps', 'soft_delete'],
};

// ============================================================================
// Fixture: message entity with restrict (default)
// ============================================================================

const messageDefinitionRestrict = {
  entity: { name: 'message', plural: 'messages', table: 'messages', pattern: 'Base' },
  fields: {
    body: { type: 'string', required: true },
  },
  relationships: {
    conversation: {
      type: 'belongs_to',
      target: 'conversation',
      foreign_key: 'conversation_id',
      nullable: false,
      on_delete: 'restrict',
    },
  },
  behaviors: [],
};

// ============================================================================
// Fixture: child entity with nullable FK and set_null
// ============================================================================

const childDefinitionSetNull = {
  entity: { name: 'comment', plural: 'comments', table: 'comments', pattern: 'Base' },
  fields: {
    body: { type: 'string', required: true },
  },
  relationships: {
    post: {
      type: 'belongs_to',
      target: 'post',
      foreign_key: 'post_id',
      nullable: true,
      on_delete: 'set_null',
    },
  },
  behaviors: [],
};

// ============================================================================
// Fixture: entity with no on_delete specified (should default to restrict)
// ============================================================================

const messageDefinitionNoOnDelete = {
  entity: { name: 'message', plural: 'messages', table: 'messages', pattern: 'Base' },
  fields: {
    body: { type: 'string', required: true },
  },
  relationships: {
    conversation: {
      type: 'belongs_to',
      target: 'conversation',
      foreign_key: 'conversation_id',
      nullable: false,
      // on_delete omitted — should default to restrict
    },
  },
  behaviors: [],
};

// ============================================================================
// Tests
// ============================================================================

describe('entity FK emission (issue #34)', () => {
  it('emits .references() with onDelete: cascade for cascade relation', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionCascade, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain(".references(() => conversations.id, { onDelete: 'cascade' })");
  });

  it('emits .references() with onDelete: restrict for restrict relation', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionRestrict, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain(".references(() => conversations.id, { onDelete: 'restrict' })");
  });

  it('emits .references() with onDelete: set null for set_null relation', () => {
    const locals = buildCleanLitePsLocals(childDefinitionSetNull, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain(".references(() => posts.id, { onDelete: 'set null' })");
  });

  it('defaults to restrict when on_delete is not specified in YAML', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionNoOnDelete, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    // Should still emit references with restrict
    expect(output).toContain(".references(() => conversations.id, { onDelete: 'restrict' })");
  });

  it('emits .notNull() for non-nullable FK columns', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionCascade, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain("conversationId: uuid('conversation_id').notNull().references(");
  });

  it('omits .notNull() for nullable FK columns', () => {
    const locals = buildCleanLitePsLocals(childDefinitionSetNull, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    // nullable: true — no .notNull()
    expect(output).toContain("postId: uuid('post_id').references(");
    expect(output).not.toContain("postId: uuid('post_id').notNull()");
  });

  it('does NOT emit soft-delete warning when entity has no soft_delete behavior', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionCascade, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).not.toContain('WARNING: on_delete');
    expect(output).not.toContain('ADR-021');
  });
});

describe('soft-delete FK warning (issue #41)', () => {
  it('emits WARNING comment before FK column on soft-delete entity with cascade', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionSoftDeleteCascade, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain('WARNING: on_delete:');
    expect(output).toContain('ADR-021');
    // Comment must appear before the column definition
    const warningPos = output.indexOf('WARNING: on_delete:');
    const columnPos = output.indexOf("conversationId: uuid('conversation_id')");
    expect(warningPos).toBeLessThan(columnPos);
  });

  it('warning comment names the YAML on_delete value', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionSoftDeleteCascade, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain("on_delete: 'cascade'");
  });

  it('emits warning on restrict relation with soft_delete too', () => {
    const softDeleteRestrict = {
      ...messageDefinitionRestrict,
      behaviors: ['soft_delete'],
    };
    const locals = buildCleanLitePsLocals(softDeleteRestrict, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    // Any belongs_to on a soft-delete entity gets the warning
    expect(output).toContain('WARNING: on_delete:');
  });

  it('still emits the FK column after the warning', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionSoftDeleteCascade, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain(".references(() => conversations.id, { onDelete: 'cascade' })");
  });
});

// ============================================================================
// external_id_tracking unique index emission
//
// The external_id_tracking behavior declares external_id with
// drizzleImports: ['varchar', 'index'] — it INTENDS an index. The entity
// template now emits a unique index over (provider, external_id), the
// ON CONFLICT target the integration sink's integrationUpsert relies on.
// ============================================================================

// Integrated entity declaring the behavior explicitly.
const integratedExplicitDefinition = {
  entity: { name: 'contact', plural: 'contacts', table: 'contacts', pattern: 'Integrated' },
  fields: { email: { type: 'string', required: true } },
  relationships: {},
  behaviors: ['timestamps', 'external_id_tracking'],
};

// Integrated entity that does NOT re-declare external_id_tracking — the pattern
// implies it (impliedBehaviors fold).
const integratedImpliedDefinition = {
  entity: { name: 'contact', plural: 'contacts', table: 'contacts', pattern: 'Integrated' },
  fields: { email: { type: 'string', required: true } },
  relationships: {},
  behaviors: ['timestamps'],
};

// Plain Base entity carrying the behavior directly (no pattern).
const baseWithBehaviorDefinition = {
  entity: { name: 'widget', plural: 'widgets', table: 'widgets', pattern: 'Base' },
  fields: { label: { type: 'string', required: true } },
  relationships: {},
  behaviors: ['external_id_tracking'],
};

// Plain Base entity WITHOUT the behavior — must emit no index.
const baseNoBehaviorDefinition = {
  entity: { name: 'widget', plural: 'widgets', table: 'widgets', pattern: 'Base' },
  fields: { label: { type: 'string', required: true } },
  relationships: {},
  behaviors: [],
};

describe('external_id_tracking unique index emission', () => {
  it('emits uniqueIndex over (provider, external_id) when behavior is declared explicitly', () => {
    const locals = buildCleanLitePsLocals(integratedExplicitDefinition, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain(
      "uniqueIndex('uq_contacts_provider_external_id').on(t.provider, t.externalId)",
    );
  });

  it('imports uniqueIndex from drizzle-orm/pg-core', () => {
    const locals = buildCleanLitePsLocals(integratedExplicitDefinition, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(locals.clpDrizzleImports).toContain('uniqueIndex');
    expect(output).toContain('uniqueIndex,');
    expect(output).toContain("from 'drizzle-orm/pg-core';");
  });

  it('passes the index as the pgTable extra-config callback returning an array', () => {
    const locals = buildCleanLitePsLocals(integratedExplicitDefinition, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    // (t) => [ ... ] form — the modern Drizzle extra-config signature.
    expect(output).toMatch(/\},\s*\(t\) => \[\s*[\s\S]*uniqueIndex\(/);
    // The index follows the column block (appears after providerMetadata).
    const colPos = output.indexOf("providerMetadata: jsonb('provider_metadata')");
    const idxPos = output.indexOf("uniqueIndex('uq_contacts_provider_external_id')");
    expect(colPos).toBeGreaterThan(-1);
    expect(idxPos).toBeGreaterThan(colPos);
  });

  it('emits the index for a pattern: Integrated entity that does NOT re-declare the behavior', () => {
    const locals = buildCleanLitePsLocals(integratedImpliedDefinition, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    // impliedBehaviors fold — pattern: Integrated implies external_id_tracking.
    expect(locals.hasExternalIdTracking).toBe(true);
    expect(output).toContain("externalId: varchar('external_id')");
    expect(output).toContain("provider: varchar('provider')");
    expect(output).toContain("providerMetadata: jsonb('provider_metadata')");
    expect(output).toContain(
      "uniqueIndex('uq_contacts_provider_external_id').on(t.provider, t.externalId)",
    );
  });

  it('emits the index for a non-Integrated entity carrying the behavior directly', () => {
    const locals = buildCleanLitePsLocals(baseWithBehaviorDefinition, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain(
      "uniqueIndex('uq_widgets_provider_external_id').on(t.provider, t.externalId)",
    );
  });

  it('does NOT emit an index or uniqueIndex import without the behavior', () => {
    const locals = buildCleanLitePsLocals(baseNoBehaviorDefinition, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(locals.clpDrizzleImports).not.toContain('uniqueIndex');
    expect(output).not.toContain('uniqueIndex');
    // pgTable closes with no extra-config callback.
    expect(output).not.toMatch(/\},\s*\(t\) => \[/);
  });
});

// ============================================================================
// belongs_to FK column inherits the underlying field's required + index
//
// When the FK column is ALSO declared as a `fields:` entry (e.g.
// `conversation_id: { type: uuid, required: true, index: true }`), the
// relationship moves that column out of clpProcessedFields into clpBelongsTo.
// The belongs_to column must still inherit the field's `required` (→ .notNull())
// and `index: true` (→ a `<table>_<col>_idx` index) — otherwise both are
// silently dropped. The .references() FK and relations() block stay intact.
// ============================================================================

// Fixture: message with conversation_id declared as a required, indexed field
// AND as a belongs_to relationship (no nullable on the relationship).
const messageDefinitionFieldBackedFk = {
  entity: { name: 'message', plural: 'messages', table: 'messages', pattern: 'Base' },
  fields: {
    body: { type: 'string', required: true },
    conversation_id: { type: 'uuid', required: true, index: true },
  },
  relationships: {
    conversation: {
      type: 'belongs_to',
      target: 'conversation',
      foreign_key: 'conversation_id',
      on_delete: 'cascade',
    },
  },
  behaviors: [],
};

describe('belongs_to FK inherits field required + index (#34 follow-on)', () => {
  it('emits .notNull() for a required:true field-backed FK (no rel.nullable)', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionFieldBackedFk, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain(
      "conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' })",
    );
  });

  it('derives nullable:false on the clpBelongsTo entry from the field required flag', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionFieldBackedFk, EMPTY_BASE_LOCALS);
    const rel = (locals.clpBelongsTo as any[]).find((r: any) => r.field === 'conversation_id');

    expect(rel).toBeDefined();
    expect(rel!.nullable).toBe(false);
    expect(rel!.hasIndex).toBe(true);
  });

  it('emits a <table>_<col>_idx index for the field-backed FK', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionFieldBackedFk, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain("index('messages_conversation_id_idx').on(t.conversationId)");
    // index() must be imported from drizzle-orm/pg-core
    expect(locals.clpDrizzleImports).toContain('index');
    expect(output).toContain('index,');
  });

  it('still emits the .references() FK and the relations() block', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionFieldBackedFk, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    // .references() DB FK preserved
    expect(output).toContain(".references(() => conversations.id, { onDelete: 'cascade' })");
    // relations() one() block preserved
    expect(output).toContain('export const messagesRelations = relations(messages');
    expect(output).toContain('conversation: one(conversations, {');
    expect(output).toContain('fields: [messages.conversationId],');
  });

  it('does NOT emit the FK column twice (it stays out of clpProcessedFields)', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionFieldBackedFk, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    // Exactly one `conversation_id` column definition (from the belongs_to loop).
    const occurrences = output.split("uuid('conversation_id')").length - 1;
    expect(occurrences).toBe(1);
  });

  it('an explicit rel.nullable:true overrides the field required flag (no .notNull())', () => {
    const override = {
      ...messageDefinitionFieldBackedFk,
      relationships: {
        conversation: {
          type: 'belongs_to',
          target: 'conversation',
          foreign_key: 'conversation_id',
          nullable: true,
          on_delete: 'cascade',
        },
      },
    };
    const locals = buildCleanLitePsLocals(override, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    expect(output).toContain("conversationId: uuid('conversation_id').references(");
    expect(output).not.toContain("conversationId: uuid('conversation_id').notNull()");
  });

  it('emits the index for a nullable indexed FK (index independent of nullability)', () => {
    const nullableIndexed = {
      entity: { name: 'message', plural: 'messages', table: 'messages', pattern: 'Base' },
      fields: {
        body: { type: 'string', required: true },
        conversation_id: { type: 'uuid', index: true },
      },
      relationships: {
        conversation: {
          type: 'belongs_to',
          target: 'conversation',
          foreign_key: 'conversation_id',
          on_delete: 'cascade',
        },
      },
      behaviors: [],
    };
    const locals = buildCleanLitePsLocals(nullableIndexed, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    // nullable (no .notNull()) but indexed
    expect(output).toContain("conversationId: uuid('conversation_id').references(");
    expect(output).not.toContain("conversationId: uuid('conversation_id').notNull()");
    expect(output).toContain("index('messages_conversation_id_idx').on(t.conversationId)");
  });

  it('does NOT emit an index when the field-backed FK has no index:true', () => {
    const noIndex = {
      entity: { name: 'message', plural: 'messages', table: 'messages', pattern: 'Base' },
      fields: {
        body: { type: 'string', required: true },
        conversation_id: { type: 'uuid', required: true },
      },
      relationships: {
        conversation: {
          type: 'belongs_to',
          target: 'conversation',
          foreign_key: 'conversation_id',
          on_delete: 'cascade',
        },
      },
      behaviors: [],
    };
    const locals = buildCleanLitePsLocals(noIndex, EMPTY_BASE_LOCALS);
    const output = render(locals as Record<string, unknown>);

    // required → notNull, but no index
    expect(output).toContain("conversationId: uuid('conversation_id').notNull().references(");
    expect(output).not.toContain('_idx');
    expect(locals.clpDrizzleImports).not.toContain('index');
  });
});

describe('prompt-extension processBelongsTo on_delete propagation', () => {
  it('includes onDelete in clpBelongsTo entries', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionCascade, EMPTY_BASE_LOCALS);
    const rel = (locals.clpBelongsTo as any[]).find((r: any) => r.field === 'conversation_id');

    expect(rel).toBeDefined();
    expect(rel!.onDelete).toBe('cascade');
    expect(rel!.onDeleteYaml).toBe('cascade');
  });

  it('maps set_null to Drizzle set null', () => {
    const locals = buildCleanLitePsLocals(childDefinitionSetNull, EMPTY_BASE_LOCALS);
    const rel = (locals.clpBelongsTo as any[]).find((r: any) => r.field === 'post_id');

    expect(rel).toBeDefined();
    expect(rel!.onDelete).toBe('set null');
    expect(rel!.onDeleteYaml).toBe('set_null');
  });

  it('defaults onDelete to restrict when on_delete absent from YAML', () => {
    const locals = buildCleanLitePsLocals(messageDefinitionNoOnDelete, EMPTY_BASE_LOCALS);
    const rel = (locals.clpBelongsTo as any[]).find((r: any) => r.field === 'conversation_id');

    expect(rel).toBeDefined();
    expect(rel!.onDelete).toBe('restrict');
    expect(rel!.onDeleteYaml).toBe('restrict');
  });
});
