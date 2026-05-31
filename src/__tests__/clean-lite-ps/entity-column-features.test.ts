/**
 * Template rendering tests for clean-lite-ps Drizzle column/table feature
 * emission — the cohesive cluster of "YAML metadata read but not emitted" bugs:
 *
 *   #345 — field `default:` → `.default(...)` / `.defaultNow()` on the column
 *   #354 — field `foreign_key: <table>.<col>` → `.references(() => ...)` + import
 *   #355 — field `index: true` → `index('<table>_<col>_idx').on(t.<col>)` in the
 *          pgTable extra-config callback + `index` import
 *   #356 — top-level `unique_indexes:` → `uniqueIndex(...).on(...)` + import
 *
 * These mirror the rendering harness in entity-fk-template.test.ts (render the
 * EJS body with locals from buildCleanLitePsLocals).
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
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return source;
  return lines.slice(end + 1).join('\n');
}

function render(definition: Record<string, unknown>): {
  output: string;
  locals: Record<string, unknown>;
} {
  const locals = buildCleanLitePsLocals(definition, {}) as Record<string, unknown>;
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
    expect(output).toContain("stateEnum('state').notNull().default('created')");
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
    expect(output).toContain("timestamp('started_at').defaultNow()");
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

  it('appends .references(() => <table>.<col>) to the FK column chain', () => {
    const { output } = render(definition);
    expect(output).toContain(
      "conversationId: uuid('conversation_id').notNull().references(() => conversations.id),",
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
    expect(output).toContain("conversationId: uuid('conversation_id').references(() => conversations.id),");
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
    expect(locals.clpHasSelfFk).toBe(true);
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
    expect(locals.clpDrizzleImports).toContain('index');
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
    expect(output).toContain(".references(() => conversations.id)");
    expect(output).toContain("index('tool_calls_conversation_id_idx').on(t.conversationId)");
  });

  it('emits no callback or index import when no field declares index', () => {
    const { output, locals } = render({
      entity: { name: 'widget', plural: 'widgets', table: 'widgets', pattern: 'Base' },
      fields: { label: { type: 'string', required: true } },
      relationships: {},
      behaviors: [],
    });
    expect(locals.clpDrizzleImports).not.toContain('index');
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
    expect(locals.clpDrizzleImports).toContain('uniqueIndex');
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
