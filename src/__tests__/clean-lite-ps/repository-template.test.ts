/**
 * Template rendering tests for clean-lite-ps/repository.ejs.t
 *
 * These tests assert the behaviors override — covered by issue #33 — is
 * emitted when the entity declares timestamps / soft_delete, and is omitted
 * otherwise. This is a template-level regression test (not a baseline
 * snapshot) because clean-lite-ps is not part of test/baseline.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildCleanLitePsLocals } from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';

const TEMPLATE_PATH = resolve(
  import.meta.dir,
  '../../../templates/entity/new/clean-lite-ps/repository.ejs.t',
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
  entity: { name: 'contact', plural: 'contacts', table: 'contacts', family: 'synced' },
  fields: {
    email: { type: 'string', required: true },
  },
  relationships: {},
};

describe('clean-lite-ps repository template — behaviors config (issue #33)', () => {
  it('emits behaviors override with softDelete: true when soft_delete behavior is present', () => {
    const def = { ...baseEntity, behaviors: ['timestamps', 'soft_delete'] };
    const locals = buildCleanLitePsLocals(def, {});
    const output = renderRepository(locals);

    expect(output).toContain('protected override readonly behaviors: BehaviorConfig');
    expect(output).toContain('timestamps: true');
    expect(output).toContain('softDelete: true');
    expect(output).toContain('userTracking: false');
    expect(output).toContain(
      "import type { BehaviorConfig } from '@shared/base-classes/base-repository';",
    );
  });

  it('emits behaviors override with softDelete: false when only timestamps is present', () => {
    const def = { ...baseEntity, behaviors: ['timestamps'] };
    const locals = buildCleanLitePsLocals(def, {});
    const output = renderRepository(locals);

    expect(output).toContain('protected override readonly behaviors: BehaviorConfig');
    expect(output).toContain('timestamps: true');
    expect(output).toContain('softDelete: false');
  });

  it('emits behaviors override with timestamps: false when only soft_delete is present', () => {
    const def = { ...baseEntity, behaviors: ['soft_delete'] };
    const locals = buildCleanLitePsLocals(def, {});
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
    const locals = buildCleanLitePsLocals(def, {});
    const output = renderRepository(locals);

    expect(output).toContain('protected override readonly behaviors: BehaviorConfig');
    expect(output).toContain('timestamps: true');
    expect(output).toContain('softDelete: false');
    expect(output).toContain('userTracking: true');
  });

  it('emits behaviors block with only userTracking: true when user_tracking is the sole behavior', () => {
    const def = { ...baseEntity, behaviors: ['user_tracking'] };
    const locals = buildCleanLitePsLocals(def, {});
    const output = renderRepository(locals);

    // The block must still be emitted (fix verified at the template
    // `if (hasTimestamps || hasSoftDelete || hasUserTracking)` guard).
    expect(output).toContain('protected override readonly behaviors: BehaviorConfig');
    expect(output).toContain('timestamps: false');
    expect(output).toContain('softDelete: false');
    expect(output).toContain('userTracking: true');
    expect(output).toContain(
      "import type { BehaviorConfig } from '@shared/base-classes/base-repository';",
    );
  });

  it('emits userTracking: false when user_tracking behavior is absent', () => {
    const def = { ...baseEntity, behaviors: ['timestamps'] };
    const locals = buildCleanLitePsLocals(def, {});
    const output = renderRepository(locals);

    expect(output).toContain('userTracking: false');
  });

  it('omits behaviors override and BehaviorConfig import when no behaviors are declared', () => {
    const def = { ...baseEntity, behaviors: [] };
    const locals = buildCleanLitePsLocals(def, {});
    const output = renderRepository(locals);

    expect(output).not.toContain('BehaviorConfig');
    expect(output).not.toContain('protected override readonly behaviors');
  });
});

describe('clean-lite-ps repository template — declarative queries use baseQuery()', () => {
  // Regression: the declarative query methods must go through baseQuery()
  // (which applies the soft-delete isNull(deletedAt) filter) rather than
  // raw this.db.select(), so soft-deleted rows don't leak through
  // findByX queries when soft_delete is enabled.
  const queriesEntity = {
    ...baseEntity,
    behaviors: ['timestamps', 'soft_delete'],
    queries: [
      { by: ['email'], unique: true },
      { by: ['user_id'] },
    ],
  };

  it('unique (findByX with limit 1) query delegates to baseQuery()', () => {
    const locals = buildCleanLitePsLocals(queriesEntity, {});
    const output = renderRepository(locals);

    expect(output).toContain('async findByEmail(email: string)');
    expect(output).toContain('await this.baseQuery()');
    // Must not use raw db.select() for the declarative read path.
    expect(output).not.toContain('this.db.select().from(this.table)');
  });

  it('non-unique list query also delegates to baseQuery()', () => {
    const locals = buildCleanLitePsLocals(queriesEntity, {});
    const output = renderRepository(locals);

    expect(output).toContain('async findByUserId(userId: string)');
    // Count the number of baseQuery() usages — should be 2 (one per query).
    const matches = output.match(/this\.baseQuery\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
