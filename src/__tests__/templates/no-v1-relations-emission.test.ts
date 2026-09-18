/**
 * DRZ-1 (#583) / REL-1 (#586) — guard: the v1 Drizzle `relations()` API stays
 * deleted, and the v2 `defineRelations()` manifest is what replaced it.
 *
 * Drizzle 1.0 removed `relations` from the `drizzle-orm` root export, so any
 * generated project carrying the v1 const stops compiling. DRZ-1 deleted the
 * emission from all three backend pipelines (entity/clean, clean-lite-ps,
 * junction) and left the slot deliberately empty. REL-1 refilled it with a
 * whole-set `defineRelations()` manifest (ADR-044), emitted by
 * `src/emitters/relations/` rather than by a template.
 *
 * Re-pointed for REL-1 in two ways:
 *
 *  1. **Wider scan.** Relation-emitting code no longer lives only under
 *     `templates/` — it lives in the relations emitter, in the init scaffold's
 *     `database.module.ts` string, and in the checked-in golden manifest. A
 *     tripwire that only watched `templates/` would no longer be watching the
 *     surface that emits relation code.
 *  2. **Precise v1 signature.** The old file-wide rule banned ANY import list
 *     containing `relations`, which the v2 wiring legitimately carries
 *     (`import { relations } from '../../generated/relations'`). The rule now
 *     names the module the v1 symbol came from — `drizzle-orm` — so it still
 *     catches the exact TS2724 that DRZ-1 fixed while letting the v2 manifest
 *     through. Nothing else was loosened: `relations(` and a quoted
 *     `'relations'` import-list entry are still banned outright.
 *
 * `defineRelations(` and `import { defineRelations } from 'drizzle-orm'` pass by
 * construction: the patterns below are case-sensitive and anchored with `\b`,
 * and in `defineRelations` the character before `relations` is a word character
 * and the `R` is capitalized.
 */

import { describe, it, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

/**
 * Every place relation-emitting code can live. A file that emits relation code
 * and is NOT listed here is outside the tripwire — add it when you add one.
 */
const SCAN_ROOTS = [
	'templates',
	'src/emitters/relations',
	'src/cli/shared/init-scaffold.ts',
	'src/cli/shared/relations-generator.ts',
	'test/relations-golden/snapshot',
];

type Forbidden = { label: string; pattern: RegExp; scope: 'line' | 'file' };

/** The v1 API surface, in every form generated or generating code could carry it. */
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
	// re-add would take, and a per-line scan can never see it. The module
	// specifier is part of the pattern — `relations` is a drizzle-orm root
	// export in v1 and nowhere else, so naming it costs no coverage and is what
	// lets the v2 manifest's own `import { relations } from './generated/…'`
	// through.
	{
		label: 'drizzle-orm root `relations` import',
		pattern: /import\s*\{[^}]*\brelations\b[^}]*\}\s*from\s*['"]drizzle-orm(\/[^'"]*)?['"]/,
		scope: 'file',
	},
];

/** 1-indexed line number of `index` within `source`. */
function lineOf(source: string, index: number): number {
	return source.slice(0, index).split('\n').length;
}

function walk(target: string): string[] {
	if (!existsSync(target)) return [];
	if (!statSync(target).isDirectory()) return [target];
	const out: string[] = [];
	for (const entry of readdirSync(target)) {
		out.push(...walk(join(target, entry)));
	}
	return out;
}

describe('v1 relations() emission stays deleted', () => {
	const files = SCAN_ROOTS.flatMap((root) => walk(resolve(REPO_ROOT, root)));

	it('finds every scan root (guards against a silently empty sweep)', () => {
		for (const root of SCAN_ROOTS) {
			expect(
				walk(resolve(REPO_ROOT, root)).length,
				`scan root disappeared: ${root}`,
			).toBeGreaterThan(0);
		}
		expect(files.length).toBeGreaterThan(50);
	});

	it('has zero v1 `relations` hits anywhere in the scanned surface', () => {
		const hits: string[] = [];

		for (const file of files) {
			const source = readFileSync(file, 'utf8');
			const lines = source.split('\n');
			const name = relative(REPO_ROOT, file);

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

	it('the v2 manifest is what refilled the slot (REL-1)', () => {
		// A tripwire that passes because the emitter vanished is not a tripwire.
		const manifest = readFileSync(
			resolve(REPO_ROOT, 'test/relations-golden/snapshot/relations.ts'),
			'utf8',
		);
		expect(manifest).toContain("import { defineRelations } from 'drizzle-orm';");
		expect(manifest).toContain('defineRelations(schema, (r) => ({');
	});
});
