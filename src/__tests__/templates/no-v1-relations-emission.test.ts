/**
 * DRZ-1 (#583) — guard: no template may reintroduce the v1 Drizzle
 * `relations()` emission.
 *
 * Drizzle 1.0 removes `relations` from the `drizzle-orm` root export, so any
 * generated project carrying the v1 const stops compiling. DRZ-1 deleted the
 * emission from all three backend pipelines (entity/clean, clean-lite-ps,
 * junction) and left the slot deliberately empty. REL-1 (#586) refills it with
 * a whole-set v2 `defineRelations()` manifest under ADR-044.
 *
 * Until then this test is the tripwire: it greps the whole template tree so a
 * partial re-add (a stray import, a quoted import-list entry, a `relations(`
 * call) fails fast in `just test-unit` rather than in a downstream smoke tsc.
 *
 * When REL-1 lands, this test is replaced by that spec's assertions. It bans
 * the v1 API surface, not the word "relation" — `relationship`, `relationKey`
 * and `defineRelations(` all pass. A template comment may not spell
 * `relations()` literally; that is deliberate, and cheap.
 */

import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const TEMPLATES_ROOT = resolve(import.meta.dir, '../../../templates');

type Forbidden = { label: string; pattern: RegExp; scope: 'line' | 'file' };

/** The v1 API surface, in every form a template could carry it. */
const FORBIDDEN: ReadonlyArray<Forbidden> = [
  // `relations(table, ({ one }) => ...)` — the const body itself.
  { label: 'relations() call', pattern: /\brelations\s*\(/, scope: 'line' },
  // `'relations'` / `"relations"` — an entry in a collected import list
  // (the pg-core import sets in prompt.js / prompt-extension.js).
  { label: "quoted 'relations' import-list entry", pattern: /['"]relations['"]/, scope: 'line' },
  // `import { relations, ... } from 'drizzle-orm'` — the root-export import
  // that is the actual TS2724 on 1.0. Neither pattern above catches it.
  //
  // Matched against the WHOLE file, not per line: every template in this repo
  // writes its import specifiers one-per-line, which is the likeliest shape a
  // re-add would take, and a per-line scan can never see it.
  {
    label: 'drizzle-orm root `relations` import',
    pattern: /import\s*\{[^}]*\brelations\b[^}]*\}\s*from/,
    scope: 'file',
  },
];

/** 1-indexed line number of `index` within `source`. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe('DRZ-1 — v1 relations() emission stays deleted', () => {
  const files = walk(TEMPLATES_ROOT);

  it('finds template files to scan (guards against a silently empty sweep)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has zero v1 `relations` hits anywhere under templates/', () => {
    const hits: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      const name = relative(TEMPLATES_ROOT, file);

      for (const { label, pattern, scope } of FORBIDDEN) {
        if (scope === 'file') {
          const match = pattern.exec(source);
          if (match) {
            hits.push(
              `${name}:${lineOf(source, match.index)} [${label}] ${match[0].replace(/\s+/g, ' ')}`,
            );
          }
          continue;
        }
        lines.forEach((line, i) => {
          if (pattern.test(line)) {
            hits.push(`${name}:${i + 1} [${label}] ${line.trim()}`);
          }
        });
      }
    }

    expect(hits).toEqual([]);
  });
});
