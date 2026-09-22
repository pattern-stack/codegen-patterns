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
const EXCLUDED_PATHS: ReadonlyArray<{ path: string; reason: string }> = [];

/** Index just past the `)` that closes the `(` at `open`, or -1 if unbalanced. */
function closeParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The source from `from` to the `}` closing the block `from` sits in — a
 * binding's scope, so a same-named variable in another method is not read as
 * this one.
 */
function enclosingBlockRest(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth < 0) return source.slice(from, i);
  }
  return source.slice(from);
}

/**
 * Every way a `.where(` can land on a builder `baseQuery(...)` returned:
 *
 *   1. chained, whatever the arguments — `baseQuery().where(`,
 *      `baseQuery(leaf).where(`, `baseQuery(and(a, b))\n  .where(` — and
 *      whatever sits between: `baseQuery(x).orderBy(y).where(`;
 *   2. assigned, then chained through the variable —
 *      `const q = this.baseQuery(); … q.where(` (also `let`, `await`, and a
 *      re-assignment `q = q.where(`).
 *
 * A regex cannot balance parentheses, which is why the first version
 * (`baseQuery\(\s*\)\s*\.where`) only ever saw the zero-argument form. This
 * walks the call's arguments and then its method chain instead.
 */
export function findBaseQueryWhere(source: string): string[] {
  const hits: string[] = [];

  // (1) chained — walk each `baseQuery(` call and the `.method(...)` chain after it.
  for (const m of source.matchAll(/\bbaseQuery\s*\(/g)) {
    let i = closeParen(source, m.index! + m[0].length - 1);
    while (i > 0) {
      const link = /^\s*\.\s*(\w+)\s*\(/.exec(source.slice(i));
      if (!link) break;
      if (link[1] === 'where') {
        hits.push(source.slice(m.index!, i + link[0].length).replace(/\s+/g, ' '));
        break;
      }
      i = closeParen(source, i + link[0].length - 1);
    }
  }

  // (2) assigned — any variable initialised from `baseQuery(` that later takes `.where(`.
  const assigned = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:await\s+)?(?:this\.)?baseQuery\s*\(/g;
  for (const m of source.matchAll(assigned)) {
    const name = m[1]!;
    const rest = enclosingBlockRest(source, m.index! + m[0].length);
    if (new RegExp(`\\b${name}\\s*\\.\\s*where\\s*\\(`).test(rest)) {
      hits.push(`${name} = baseQuery(…); ${name}.where(`);
    }
  }

  return hits;
}

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

describe('findBaseQueryWhere — the detector itself', () => {
  // A shape test is only as good as its detector. Each forbidden form is
  // proven caught, and the safe form proven clean, so widening or narrowing
  // the detector cannot silently regress it.
  const caught: ReadonlyArray<[string, string]> = [
    ['zero-arg chained', 'const r = await this.baseQuery().where(eq(t.id, id));'],
    ['arg chained', 'const r = await this.baseQuery(x).where(y);'],
    ['nested-arg chained', 'this.baseQuery(and(eq(a, 1), eq(b, 2))).where(c)'],
    ['chained across lines', 'this.baseQuery(leaf)\n      .where(other)'],
    ['chained after another link', 'this.baseQuery(leaf).orderBy(desc(t.at)).where(other)'],
    ['assigned then .where', 'const q = this.baseQuery();\nconst rows = await q.where(leaf);'],
    ['let, re-assigned', 'let q = this.baseQuery(leaf);\nif (f) q = q.where(other);'],
    ['typed binding', 'const q: Q = this.baseQuery();\nq\n  .where(x)'],
  ];
  for (const [label, src] of caught) {
    it(`catches: ${label}`, () => {
      expect(findBaseQueryWhere(src).length).toBeGreaterThan(0);
    });
  }

  const clean: ReadonlyArray<[string, string]> = [
    ['leaf passed in', 'const r = await this.baseQuery(eq(t.id, id));'],
    ['ordered + limited', 'this.baseQuery(leaf).orderBy(desc(t.at)).limit(10)'],
    ['assigned, never .where', 'let q = this.baseQuery(leaf);\nq = q.orderBy(x);'],
    ['an unrelated builder\'s .where', 'const q = this.db.select().from(t);\nq.where(x);'],
    [
      'same name, another method',
      'list() {\n  let query = this.baseQuery(w);\n  return query;\n}\ncount() {\n  const query = this.db.select();\n  return query.where(s);\n}',
    ],
  ];
  for (const [label, src] of clean) {
    it(`leaves alone: ${label}`, () => {
      expect(findBaseQueryWhere(src)).toEqual([]);
    });
  }
});

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

  it('finds no .where() on a baseQuery() builder in templates/ or runtime/', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const source = stripCommentLines(
        readFileSync(resolve(REPO_ROOT, rel), 'utf8'),
      );
      if (findBaseQueryWhere(source).length > 0) offenders.push(rel);
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

  it('has no exclusions — a future one must name a live file with the shape', () => {
    expect(EXCLUDED_PATHS).toEqual([]);
    for (const { path, reason } of EXCLUDED_PATHS) {
      const source = stripCommentLines(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
      expect(findBaseQueryWhere(source).length, `${path} (${reason})`).toBeGreaterThan(0);
    }
  });
});
