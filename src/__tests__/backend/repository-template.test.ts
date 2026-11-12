/**
 * Template rendering tests for backend/repository.ejs.t
 *
 * These tests assert the behaviors override — covered by issue #33 — is
 * emitted when the entity declares timestamps / soft_delete, and is omitted
 * otherwise. Also covers issue #38: hasUserTracking is plumbed from the
 * behaviors array instead of being hard-coded to false.
 *
 * This is a template-level regression test (not a baseline snapshot) because
 * backend is not part of test/baseline.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { withEntities } from './_entity-lookup';

const TEMPLATE_PATH = resolve(
  import.meta.dir,
  '../../../templates/entity/new/backend/repository.ejs.t',
);
const TEMPLATE_SOURCE = readFileSync(TEMPLATE_PATH, 'utf8');

/**
 * Strip the Hygen front-matter (the `---` block at the top) so we render
 * only the body, matching what Hygen itself does before handing the body
 * to EJS.
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

function renderRepository(locals: Record<string, unknown>): string {
  const body = extractBody(TEMPLATE_SOURCE);
  return ejs.render(body, locals, { rmWhitespace: false });
}

const baseEntity = {
  entity: { name: 'contact', plural: 'contacts', pattern: 'Integrated' },
  fields: {
    email: { type: 'string', required: true },
  },
  relationships: {},
};

describe('backend repository template — behaviors config (issue #33)', () => {
  it('emits behaviors override with softDelete: true when soft_delete behavior is present', () => {
    const def = { ...baseEntity, behaviors: ['timestamps', 'soft_delete'] };
    const locals = buildBackendLocals(def, withEntities());
    const output = renderRepository(locals);

    expect(output).toContain('protected override readonly behaviors: BehaviorConfig');
    expect(output).toContain('timestamps: true');
    expect(output).toContain('softDelete: true');
    expect(output).toContain('userTracking: false');
    expect(output).toContain(
      "import type { BehaviorConfig, ListOptions, ReadOptions, RowFilter } from '@shared/base-classes/base-repository';",
    );
  });

  it('emits behaviors override with softDelete: false when only timestamps is present', () => {
    const def = { ...baseEntity, behaviors: ['timestamps'] };
    const locals = buildBackendLocals(def, withEntities());
    const output = renderRepository(locals);

    expect(output).toContain('protected override readonly behaviors: BehaviorConfig');
    expect(output).toContain('timestamps: true');
    expect(output).toContain('softDelete: false');
  });

  it('emits behaviors override with timestamps: false when only soft_delete is present', () => {
    const def = { ...baseEntity, behaviors: ['soft_delete'] };
    const locals = buildBackendLocals(def, withEntities());
    const output = renderRepository(locals);

    expect(output).toContain('protected override readonly behaviors: BehaviorConfig');
    expect(output).toContain('timestamps: false');
    expect(output).toContain('softDelete: true');
  });

  // Issue #38 — hasUserTracking plumbed through prompt-extension.
  // Previously the template hard-coded `userTracking: false` even when the
  // entity declared `user_tracking` in its behaviors array.
  it('emits behaviors override with userTracking: true when user_tracking behavior is present', () => {
    const def = { ...baseEntity, behaviors: ['timestamps', 'user_tracking'] };
    const locals = buildBackendLocals(def, withEntities());
    const output = renderRepository(locals);

    expect(output).toContain('protected override readonly behaviors: BehaviorConfig');
    expect(output).toContain('timestamps: true');
    expect(output).toContain('softDelete: false');
    expect(output).toContain('userTracking: true');
  });

  it('emits behaviors block with only userTracking: true when user_tracking is the sole behavior', () => {
    const def = { ...baseEntity, behaviors: ['user_tracking'] };
    const locals = buildBackendLocals(def, withEntities());
    const output = renderRepository(locals);

    // The block must still be emitted (fix verified at the template
    // `if (hasTimestamps || hasSoftDelete || hasUserTracking)` guard).
    expect(output).toContain('protected override readonly behaviors: BehaviorConfig');
    expect(output).toContain('timestamps: false');
    expect(output).toContain('softDelete: false');
    expect(output).toContain('userTracking: true');
    expect(output).toContain(
      "import type { BehaviorConfig, ListOptions, ReadOptions, RowFilter } from '@shared/base-classes/base-repository';",
    );
  });

  it('emits userTracking: false when user_tracking behavior is absent', () => {
    const def = { ...baseEntity, behaviors: ['timestamps'] };
    const locals = buildBackendLocals(def, withEntities());
    const output = renderRepository(locals);

    expect(output).toContain('userTracking: false');
  });

  it('omits behaviors override and BehaviorConfig import when no behaviors are declared', () => {
    const def = { ...baseEntity, behaviors: [] };
    const locals = buildBackendLocals(def, withEntities());
    const output = renderRepository(locals);

    expect(output).not.toContain('BehaviorConfig');
    expect(output).not.toContain('protected override readonly behaviors');
  });
});

describe('backend repository template — user_tracking behavior (issue #38)', () => {
  it('emits userTracking: true when user_tracking behavior is declared', () => {
    const def = { ...baseEntity, behaviors: ['timestamps', 'user_tracking'] };
    const locals = buildBackendLocals(def, withEntities());
    const output = renderRepository(locals);

    expect(output).toContain('userTracking: true');
    expect(output).not.toContain('userTracking: false');
  });

  it('emits userTracking: false when user_tracking behavior is absent', () => {
    const def = { ...baseEntity, behaviors: ['timestamps', 'soft_delete'] };
    const locals = buildBackendLocals(def, withEntities());
    const output = renderRepository(locals);

    expect(output).toContain('userTracking: false');
    expect(output).not.toContain('userTracking: true');
  });

  it('emits userTracking: true alongside soft_delete when both are present', () => {
    const def = { ...baseEntity, behaviors: ['timestamps', 'soft_delete', 'user_tracking'] };
    const locals = buildBackendLocals(def, withEntities());
    const output = renderRepository(locals);

    expect(output).toContain('softDelete: true');
    expect(output).toContain('userTracking: true');
  });
});

describe('backend repository template — every shaped read carries its predicate INTO rootFilter (READ-1)', () => {
  // SCOPE-0 (#616) found finders that chained `.where(...)` onto `baseQuery()`
  // and so REPLACED its guards. READ-1 moved every shaped read onto the
  // relational path, where the same rule reads: the leaf predicate is handed to
  // `this.rootFilter(...)` — which ANDs the scope — as a function of the ALIASED
  // root `t`. It is never a second `where` beside it, and never rendered against
  // `this.table` (that names a table RQBv2 aliased away — REL-2 Found #9, #840).
  const queriesEntity = {
    ...baseEntity,
    behaviors: ['timestamps', 'soft_delete'],
    queries: [
      { by: ['email'], unique: true },
      { by: ['user_id'] },
    ],
  };

  it('unique finder: the predicate is rootFilter\'s argument, rendered on `t`', () => {
    const output = renderRepository(buildBackendLocals(queriesEntity, withEntities()));
    expect(output).toContain('async findByEmail<C extends ContactColumns | undefined = undefined>(');
    expect(output).toContain('where: { RAW: this.rootFilter((t) => eq(t.email, email)) },');
    expect(output).not.toContain('this.db.select().from(this.table)');
  });

  it('non-unique finder: the same, through findMany', () => {
    const output = renderRepository(buildBackendLocals(queriesEntity, withEntities()));
    expect(output).toContain('async findByUserId<C extends ContactColumns | undefined = undefined>(');
    expect(output).toContain('where: { RAW: this.rootFilter((t) => eq(t.userId, userId)) },');
  });

  it('every relational read has exactly one root predicate, and it is rootFilter', () => {
    const output = renderRepository(buildBackendLocals(queriesEntity, withEntities()));
    expect(output).not.toMatch(/baseQuery\(\s*\)\s*\.where\s*\(/);
    const reads = output.match(/this\.db\.query\.contacts\.find(First|Many)\(/g) ?? [];
    const roots = output.match(/where: \{ RAW: this\.rootFilter\(/g) ?? [];
    // findById, findByIds, list, findByEmail, findByUserId
    expect(reads.length).toBe(5);
    expect(roots.length).toBe(reads.length);
    // Nothing on the relational path renders against the repository's own table.
    expect(output).not.toContain("this.rootFilter((t) => eq(this.table");
  });

  it('a multi-column finder ANDs its predicates inside rootFilter', () => {
    const output = renderRepository(
      buildBackendLocals(
        { ...baseEntity, behaviors: ['timestamps', 'soft_delete'], queries: [{ by: ['email', 'user_id'] }] },
        withEntities(),
      ),
    );
    expect(output).toContain(
      'where: { RAW: this.rootFilter((t) => and(eq(t.email, email), eq(t.userId, userId))) },',
    );
  });

  it('the FK-traversal finder carries its predicate into rootFilter and its limit into the statement', () => {
    const output = renderRepository(
      buildBackendLocals(
        {
          ...baseEntity,
          behaviors: ['timestamps', 'soft_delete'],
          relationships: { account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
        },
        withEntities(),
      ),
    );
    expect(output).toContain('where: { RAW: this.rootFilter((t) => eq(t.accountId, id)) },');
    expect(output).toContain('limit: opts?.limit,');
    expect(output).not.toContain('(q as any)');
  });

  it('findByIds de-duplicates, skips an empty list, and restores input order', () => {
    const output = renderRepository(buildBackendLocals(queriesEntity, withEntities()));
    expect(output).toContain('const unique = this.uniqueIds(ids);');
    expect(output).toContain('if (unique.length === 0) {\n      // No statement — but the same boundary check one would make (strict throws).\n      this.assertReadScope();\n      return [];\n    }');
    expect(output).toContain('where: { RAW: this.rootFilter((t) => inArray(t.id, unique)) },');
    expect(output).toContain('return this.inInputOrder(rows, unique, mask.stripId)');
  });

  it('every mask passes through checkColumns<C> with an EXPLICIT type argument (READ-1 §10 Found #1)', () => {
    // Dropping `<C>` is clean on rc.4 and 70+ TS2352 on rc.5 — the rc.5 typecheck
    // leg of `just test-baseline` is the real gate; this pins the shape cheaply.
    const output = renderRepository(buildBackendLocals(queriesEntity, withEntities()));
    const masked = output.match(/columns: (this\.checkColumns|mask\.columns)/g) ?? [];
    const typed = output.match(/this\.checkColumns<C>\((opts|query)\?\.columns\)/g) ?? [];
    expect(output).not.toMatch(/this\.checkColumns\(/);
    expect(typed.length).toBe(masked.length);
    expect(typed.length).toBeGreaterThanOrEqual(5);
  });

  it('the constructor fails fast when the client has no relational query for the table (review #8a)', () => {
    const output = renderRepository(buildBackendLocals(queriesEntity, withEntities()));
    expect(output).toContain("this.requireRelationalQuery('contacts');");
  });

  it('the constructor claims the read names it defines, so a base or mixin override of one throws (READ-1 §3.4)', () => {
    const output = renderRepository(buildBackendLocals(queriesEntity, withEntities()));
    expect(output).toContain('this.claimGeneratedReads(ContactRepository);');
  });

  it('a relation-less entity takes `columns` but no `with` (REL-2 §2.5)', () => {
    const output = renderRepository(buildBackendLocals(queriesEntity, withEntities()));
    expect(output).toContain('opts?: ReadOptions<never, C>,');
    expect(output).not.toContain('with: opts?.with');
  });
});

describe('backend repository template — belongs_to + explicit FK query collision (TS2393)', () => {
  // Regression: an entity with BOTH a `belongs_to` on a column AND an explicit
  // `queries: [{ by: [that_fk_column], unique: true }]` previously emitted
  // `findByFieldDefinitionId` TWICE — once from the declarative-query generator
  // (single-row return) and once from the belongs_to FK-traversal generator
  // (array return) → "Duplicate function implementation" (TS2393). Exactly one
  // method must emit; the explicit declarative query is the more specific intent.
  const collisionEntity = {
    entity: {
      name: 'field_config',
      plural: 'field_configs',
      pattern: 'Base',
    },
    fields: { value: { type: 'string', required: true } },
    relationships: {
      field_definition: {
        type: 'belongs_to',
        target: 'field_definition',
        foreign_key: 'field_definition_id',
      },
    },
    queries: [{ by: ['field_definition_id'], unique: true }],
    behaviors: [],
  };

  // A finder is generic over its read options (`async findByX<C extends …>(`),
  // so the definition marker is the name followed by `<` or `(`.
  const countMethodDefs = (out: string, method: string): number =>
    (out.match(new RegExp(`async ${method}[<(]`, 'g')) ?? []).length;

  it('emits findByFieldDefinitionId exactly ONCE when belongs_to + unique query collide', () => {
    const locals = buildBackendLocals(collisionEntity, withEntities());
    const output = renderRepository(locals);

    expect(countMethodDefs(output, 'findByFieldDefinitionId')).toBe(1);
  });

  it('keeps the declarative (unique, single-row) method and drops the FK-traversal array method', () => {
    const locals = buildBackendLocals(collisionEntity, withEntities());
    const output = renderRepository(locals);

    // The surviving method is the unique declarative one — single-row return.
    // REL-2 (#587): it is now generic over its include, and the single-row shape
    // shows in the return type rather than in the parameter list.
    expect(output).toContain(
      'async findByFieldDefinitionId<W extends FieldConfigInclude = FieldConfigNoInclude, C extends FieldConfigColumns | undefined = undefined>(\n' +
        '    fieldDefinitionId: string,\n' +
        '    opts?: ReadOptions<W, C>,\n' +
        '  ): Promise<FieldConfigResult<W, C> | null>',
    );
    // The FK-traversal array variant must NOT also be emitted.
    expect(output).not.toContain('opts?: { limit?: number } & ReadOptions<W, C>,');
  });

  it('still emits the FK-traversal method when there is NO colliding declarative query (CGP-358 unchanged)', () => {
    // A non-unique declarative query on the same column → FK method wins
    // (CGP-358), declarative impl is skipped; either way exactly one method.
    const nonUnique = {
      ...collisionEntity,
      queries: [{ by: ['field_definition_id'] }],
    };
    const output = renderRepository(buildBackendLocals(nonUnique, withEntities()));
    expect(countMethodDefs(output, 'findByFieldDefinitionId')).toBe(1);
    // The FK-traversal (limit) variant is the survivor here, now carrying
    // the include as a third option (REL-2 §4).
    expect(output).toContain('opts?: { limit?: number } & ReadOptions<W, C>,');
  });

  it('emits the FK-traversal method when there are no declarative queries at all', () => {
    const noQueries = { ...collisionEntity, queries: undefined as unknown as [] };
    const output = renderRepository(buildBackendLocals(noQueries, withEntities()));
    expect(countMethodDefs(output, 'findByFieldDefinitionId')).toBe(1);
    expect(output).toContain('opts?: { limit?: number } & ReadOptions<W, C>,');
    // No `cursor` it would ignore, and a `limit` is a stable subset: ordered by id.
    expect(output).not.toContain('cursor');
    expect(output).toContain("orderBy: opts?.limit === undefined ? undefined : { id: 'asc' },");
  });
});
