/**
 * SCOPE-0 (#616) — guard: nothing may chain `.where(...)` onto the builder
 * returned by `BaseRepository.baseQuery()`.
 *
 * `baseQuery()` returns a `$dynamic()` SELECT that ALREADY carries the guard
 * predicate assembled by `scopeAnd()` — the soft-delete exclusion and the
 * `userTracking` scope (and, from TEN-1, the tenant predicate). Drizzle's
 * `.where()` REPLACES the builder's condition rather than AND-ing it
 * (`pg-core/query-builders/select.js`: `this.config.where = where`), so
 * `this.baseQuery().where(<leaf>)` issues `WHERE <leaf>` alone and silently
 * drops every guard.
 *
 * 17 sites shipped that way — 3 clean-lite-ps / 2 junction / 2 relationship
 * template bodies plus 10 in the family repositories — which is why this is a
 * build-breaking shape test and not a comment. The safe form is
 * `this.baseQuery(<leaf>)`; the guards are then assembled in exactly one
 * place, `scopeAnd()`, and cannot be replaced from outside it.
 *
 * Scans BOTH trees a leak could live in: `templates/` (what we emit into a
 * consumer) and `runtime/` (what we ship them). Comment lines are excluded so
 * the docblocks that explain the rule — including `baseQuery()`'s own — may
 * spell it out.
 */

import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const SCAN_ROOTS = ['templates', 'runtime'] as const;
const SCAN_EXTENSIONS = ['.ts', '.ejs.t', '.js'] as const;

/**
 * The ONE exclusion, named and single-purpose (charter I9): the `clean`
 * backend pipeline declares its own PRIVATE `baseQuery()` inside each emitted
 * repository — a different method with different semantics, not this runtime's
 * base class. That pipeline is known-red and out of scope (#602, charter I11),
 * so fixing its bodies here would be untestable churn. This is an exclusion by
 * PATH, for a named reason, with the issue number — never a dropped error
 * class and never a directory carve-out in a gate's output filter.
 */
const EXCLUDED_PATHS: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'templates/entity/new/backend/database/repository.ejs.t',
    reason: "the `clean` pipeline's own private baseQuery() — #602, out of scope (I11)",
  },
];

/** `baseQuery()` … `.where(` with any whitespace, including newlines, between. */
const FORBIDDEN = /\bbaseQuery\(\s*\)\s*\.where\s*\(/;

/** Blank out comment-only lines so docblocks may quote the forbidden shape. */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      const isComment =
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*');
      return isComment ? '' : line;
    })
    .join('\n');
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, acc);
    } else if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      acc.push(full);
    }
  }
  return acc;
}

describe('SCOPE-0 — no .where() on a baseQuery() builder', () => {
  const excluded = new Set(EXCLUDED_PATHS.map((e) => e.path));

  const files = SCAN_ROOTS.flatMap((root) => walk(resolve(REPO_ROOT, root)))
    .map((full) => relative(REPO_ROOT, full))
    .filter((rel) => !excluded.has(rel))
    .sort();

  it('scans both the template and runtime trees', () => {
    // A guard that silently scans nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.startsWith('templates/'))).toBe(true);
    expect(files.some((f) => f.startsWith('runtime/'))).toBe(true);
  });

  it('finds no `baseQuery().where(` in templates/ or runtime/', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const source = stripCommentLines(
        readFileSync(resolve(REPO_ROOT, rel), 'utf8'),
      );
      if (FORBIDDEN.test(source)) offenders.push(rel);
    }

    expect(
      offenders,
      offenders.length > 0
        ? `\`.where()\` REPLACES the guard predicate baseQuery() already applied ` +
            `(soft-delete + userTracking scope). Pass the leaf predicate as ` +
            `baseQuery(<leaf>) instead. See docs/specs/SCOPE-0.md (#616). Offenders:\n  ` +
            offenders.join('\n  ')
        : undefined,
    ).toEqual([]);
  });

  it('keeps the one excluded path honest', () => {
    // The exclusion must name a file that EXISTS and that genuinely still has
    // the shape — otherwise it is dead weight hiding nothing, and should go.
    for (const { path, reason } of EXCLUDED_PATHS) {
      const source = stripCommentLines(
        readFileSync(resolve(REPO_ROOT, path), 'utf8'),
      );
      expect(FORBIDDEN.test(source), `${path} (${reason})`).toBe(true);
    }
  });
});
