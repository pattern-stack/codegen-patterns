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
