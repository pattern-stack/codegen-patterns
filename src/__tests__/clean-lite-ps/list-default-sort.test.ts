/**
 * Template rendering tests for the clean-lite-ps list/search default sort
 * (#604 / GATE-2).
 *
 * The default sort used to be `desc(<plural>.createdAt), desc(<plural>.id)`
 * unconditionally. `resolveListQuery` defaults `sort_by` to `created_at`, so an
 * entity with no `timestamps` behavior ALWAYS took that branch — and emitted a
 * file that did not compile (`Property 'createdAt' does not exist on type
 * PgTableWithColumns<…>`). Six of eight fixture entities in the
 * integration-patterns set hit it, visibly, for as long as
 * `just test-smoke-integration` carved those errors out of its failure check.
 *
 * The rule these tests pin: **the default sort may only name a column the
 * entity actually declares.** Without `timestamps`, the uuid primary key alone
 * is the default — already a total order, which is the property the `id`
 * tie-break exists for.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ejs from 'ejs';
import { buildCleanLitePsLocals } from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';
import { withEntities } from './_entity-lookup';

const TEMPLATE_ROOT = resolve(
  import.meta.dir,
  '../../../templates/entity/new/clean-lite-ps',
);

/** Strip the Hygen front-matter so we render only the body, as Hygen does. */
function extractBody(source: string): string {
  const lines = source.split('\n');
  if (lines[0] !== '---') return source;
  const end = lines.indexOf('---', 1);
  return end === -1 ? source : lines.slice(end + 1).join('\n');
}

function render(relPath: string, definition: unknown): string {
  const body = extractBody(readFileSync(resolve(TEMPLATE_ROOT, relPath), 'utf8'));
  const locals = buildCleanLitePsLocals(definition, withEntities());
  return ejs.render(body, locals, { rmWhitespace: false });
}

// ---------------------------------------------------------------------------
// Fixtures: the same entity with and without the `timestamps` behavior.
// ---------------------------------------------------------------------------

const withoutTimestamps = {
  entity: { name: 'account', plural: 'accounts', table: 'accounts', pattern: 'Base' },
  fields: {
    name: { type: 'string', required: true },
  },
  behaviors: [],
};

const withTimestamps = { ...withoutTimestamps, behaviors: ['timestamps'] };

/** Same pair, carrying a `search` query so search.ejs.t renders its body. */
const searchQuery = [{ name: 'search', filters: ['name'], search: 'name', paginate: true }];
const searchWithoutTimestamps = { ...withoutTimestamps, queries: searchQuery };
const searchWithTimestamps = { ...withTimestamps, queries: searchQuery };

// ===========================================================================
// list.ejs.t
// ===========================================================================

describe('clean-lite-ps list use-case — default sort', () => {
  it('never accesses a createdAt column for an entity without timestamps (#604)', () => {
    const out = render('use-cases/list.ejs.t', withoutTimestamps);

    // The assertion that would have caught #604. Matched as a PROPERTY ACCESS
    // (`<table>.createdAt`), not as a substring: the emitted prose explains why
    // there is no `created_at` here, and must be allowed to say the words. What
    // may not survive is a read of a column the entity does not declare — that
    // is the thing that does not compile.
    expect(out).not.toMatch(/\.createdAt\b/);
    // And no line of code (as opposed to comment) may mention it at all.
    const code = out
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toContain('createdAt');
    expect(code).not.toContain('created_at');
  });

  it('defaults to the primary key alone when there are no timestamps', () => {
    const out = render('use-cases/list.ejs.t', withoutTimestamps);

    expect(out).toContain('? sql`${desc(accounts.id)}`');
  });

  it('keeps created_at + id as the default when timestamps are declared', () => {
    const out = render('use-cases/list.ejs.t', withTimestamps);

    expect(out).toContain('? sql`${desc(accounts.createdAt)}, ${desc(accounts.id)}`');
  });

  it('keeps the id tie-break on the caller-supplied-sort branch either way', () => {
    const tieBreak = ': sql`${dir(col as never)}, ${desc(accounts.id)}`';

    expect(render('use-cases/list.ejs.t', withoutTimestamps)).toContain(tieBreak);
    expect(render('use-cases/list.ejs.t', withTimestamps)).toContain(tieBreak);
  });

  it('documents the sort it actually emits, in both shapes', () => {
    expect(render('use-cases/list.ejs.t', withTimestamps)).toContain(
      'sort `created_at desc, id desc`',
    );
    expect(render('use-cases/list.ejs.t', withoutTimestamps)).toContain('sort `id desc`');
  });

  it('does not promise a keyset seam it cannot have without timestamps', () => {
    const out = render('use-cases/list.ejs.t', withoutTimestamps);

    // The seam directive itself (`// KEYSET SEAM (deferred …`) must be gone —
    // the replacement comment explains its absence, so match the directive, not
    // the phrase.
    expect(out).not.toMatch(/^\s*\/\/ KEYSET SEAM \(/m);
    expect(out).toContain('No KEYSET SEAM here');
    expect(out).toContain('nextCursor` is always null here');
    // …and it is still there where it is real.
    expect(render('use-cases/list.ejs.t', withTimestamps)).toMatch(
      /^\s*\/\/ KEYSET SEAM \(/m,
    );
  });

  it('renders valid TypeScript in both shapes (balanced ternary, one orderBy)', () => {
    for (const definition of [withoutTimestamps, withTimestamps]) {
      const out = render('use-cases/list.ejs.t', definition);
      expect(out.match(/const orderBy: SQL =/g)).toHaveLength(1);
      // Exactly one `?` branch and one `:` branch survive the EJS conditionals.
      expect(out.match(/^\s+\? sql`/gm)).toHaveLength(1);
      expect(out.match(/^\s+: sql`/gm)).toHaveLength(1);
    }
  });
});

// ===========================================================================
// search.ejs.t — the same hard-coding, one template over
// ===========================================================================

describe('clean-lite-ps search use-case — default sort', () => {
  it('orders by the primary key when there are no timestamps (#604)', () => {
    const out = render('use-cases/search.ejs.t', searchWithoutTimestamps);

    expect(out).toContain('orderBy: asc(accounts.id)');
    expect(out).not.toMatch(/\.createdAt\b/);
  });

  it('still orders by created_at when timestamps are declared', () => {
    const out = render('use-cases/search.ejs.t', searchWithTimestamps);

    expect(out).toContain('orderBy: asc(accounts.createdAt)');
  });

  it('emits exactly one service.list call in both shapes', () => {
    for (const definition of [searchWithoutTimestamps, searchWithTimestamps]) {
      const out = render('use-cases/search.ejs.t', definition);
      expect(out.match(/this\.service\.list\(/g)).toHaveLength(1);
    }
  });
});
