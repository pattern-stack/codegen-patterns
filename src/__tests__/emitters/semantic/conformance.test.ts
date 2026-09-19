/**
 * Semantic emitter — vocabulary conformance against the sibling package
 * (SEM-2 §4, PLAN §5.3).
 *
 * `@pattern-stack/query-surface` is not published (query-surface#40), so the
 * emitted model carries a VERBATIM mirror of its vocabulary instead of
 * importing it. A mirror nobody checks is a mirror that drifts.
 *
 * THE PROPERTY UNDER TEST: the mirror is a **sound narrowing** of the package's
 * vocabulary. Concretely, for each mirrored declaration —
 *
 *   - a member declared on BOTH sides must have the same type  → drift, FAIL;
 *   - a member the package declares and the mirror omits is allowed ONLY if it
 *     is in `TOLERATED_OMISSIONS` below, each with a reason;
 *   - a member the mirror declares and the package does not is a FAIL, with one
 *     named exception: the `has_one` relationship kind (query-surface#40).
 *
 * An emitted model has to be ASSIGNABLE TO the package's types, not identical
 * to them, so exact equality would be the wrong assertion — it would force the
 * mirror to carry EAV and expression-measure machinery SEM-2 never populates.
 *
 * WHAT IS *NOT* COMPARED: `AggregateModel` / `EntityDescriptor` are checked by
 * member name only. They reference `PgTable` / `PgColumn` and the two checkouts
 * pin different Drizzle majors, so comparing their member types would report
 * version skew rather than real drift.
 *
 * WHICH PACKAGE REVISION IT PINS. The mirror matches query-surface `main` from
 * before query-surface#41 (17/17 there). Against #41's head it fails 2 tests —
 * the `has_one` tripwires below — and that is terminal, not a tripwire to
 * delete: #41 also orders the kind union `belongs_to | has_one | has_many`
 * where the mirror has `belongs_to | has_many | has_one`, and unions are
 * compared verbatim. #41 is the change that publishes the package, so the only
 * exit when this goes red is SEM-4: retire the mirror and delete this file
 * (docs/specs/SEM-2.md §4). Editing the mirror to chase #41 would make it fail
 * against `main` instead, for a mirror that exists only until #41 ships.
 *
 * WHEN THERE IS NO CHECKOUT the suite SKIPS and PRINTS WHY, naming the env var.
 * That is a named, single-purpose skip with a stated reason — visible in
 * `just test-all` output — not a filter that hides a class of failure (I9).
 *
 *   QUERY_SURFACE_PATH=/path/to/query-surface bun test …
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildSemanticTypes } from '../../../emitters/semantic/emit-types';

/** Package source file → the declarations mirrored from it. */
const MIRRORED: Array<{ file: string; types: string[] }> = [
	{
		file: 'src/internal/analytics/types.ts',
		types: [
			'Agg',
			'Additivity',
			'AggColType',
			'AggFieldMeta',
			'AggRelationship',
			'AggEntity',
			'AggRegistry',
		],
	},
	{
		file: 'src/internal/analytics/measure-catalog.ts',
		types: [
			'DerivedExpr',
			'AtomicMeasureDef',
			'RatioMeasureDef',
			'CumulativeMeasureDef',
			'DerivedMeasureDef',
			'MeasureDef',
			'MeasureCatalog',
		],
	},
	{ file: 'src/adapters/drizzle/registry/registry.ts', types: ['RelDescriptor'] },
];

/**
 * Members the package declares that the mirror deliberately omits, with the
 * reason. Each entry is a decision recorded in docs/specs/SEM-2.md, not a
 * tolerance for drift: adding one means deciding SEM-2 will never populate it.
 */
const TOLERATED_OMISSIONS: Record<string, Record<string, string>> = {
	AggFieldMeta: {
		eav: 'EAV is out of scope for SEM-2 (PLAN §5.3); the emitter never sets it.',
	},
	AtomicMeasureDef: {
		where:
			'A conditional measure is a host-side catalog addition; SEM-2 emits no atomic entries at all (the package derives them from the field tags).',
	},
};

/**
 * Members whose type the mirror deliberately states differently, with the
 * reason. The package name is a type SEM-2 cannot reference.
 */
const TOLERATED_TYPE_DIFFERENCES: Record<string, Record<string, string>> = {
	AtomicMeasureDef: {
		on: '`RowExpr` is package-internal; SEM-2 emits no atomic entries, so the mirror narrows to the column-name form.',
	},
};

/**
 * Named single-purpose expectation. When it fires, the package has `has_one`
 * — i.e. query-surface#41 is in the checkout — and the exit is SEM-4 retiring
 * the mirror (this whole file goes), not deleting the expectation.
 */
const HAS_ONE_ISSUE = 'pattern-stack/query-surface#41';

function findSibling(): string | null {
	const fromEnv = process.env.QUERY_SURFACE_PATH;
	if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
	const repoRoot = resolve(import.meta.dir, '../../../..');
	for (const candidate of ['../query-surface', '../../query-surface']) {
		const dir = resolve(repoRoot, candidate);
		if (existsSync(resolve(dir, 'src/internal/analytics/types.ts'))) return dir;
	}
	return null;
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function normalise(text: string): string {
	return text.replace(/\s+/g, ' ').replace(/;\s*}/g, ' }').trim();
}

/** The body of `export interface X { … }` or the RHS of `export type X = …;`. */
function extractDeclaration(source: string, name: string): string | null {
	const stripped = stripComments(source);

	const iface = new RegExp(`export interface ${name}\\s*\\{`).exec(stripped);
	if (iface) {
		let depth = 0;
		let i = iface.index + iface[0].length - 1;
		const start = i;
		for (; i < stripped.length; i++) {
			if (stripped[i] === '{') depth++;
			else if (stripped[i] === '}' && --depth === 0) break;
		}
		return normalise(stripped.slice(start, i + 1));
	}

	// A union of object members contains `;` inside braces, so run to the first
	// `;` at brace depth 0 rather than the first `;` at all.
	const alias = new RegExp(`export type ${name}\\s*=`).exec(stripped);
	if (alias) {
		let depth = 0;
		let i = alias.index + alias[0].length;
		const start = i;
		for (; i < stripped.length; i++) {
			const ch = stripped[i];
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
			else if (ch === ';' && depth === 0) break;
		}
		return normalise(stripped.slice(start, i));
	}
	return null;
}

/** `{ a: X; b?: Y }` → `{ a: 'X', 'b?': 'Y' }`, top level only. */
function members(decl: string): Record<string, string> {
	const body = decl.startsWith('{') ? decl.slice(1, -1) : decl;
	const out: Record<string, string> = {};
	let depth = 0;
	let current = '';
	const parts: string[] = [];
	for (const ch of body) {
		if (ch === '{' || ch === '(' || ch === '[') depth++;
		if (ch === '}' || ch === ')' || ch === ']') depth--;
		if (ch === ';' && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	parts.push(current);
	for (const part of parts) {
		const m = /^\s*(\w+)(\??)\s*:\s*([\s\S]+)$/.exec(part);
		if (m) out[`${m[1]}${m[2]}`] = normalise(m[3]!);
	}
	return out;
}

const siblingRoot = findSibling();
const mirror = buildSemanticTypes();

if (siblingRoot === null) {
	console.log(
		'[SEM-2 conformance] SKIPPED — no @pattern-stack/query-surface checkout found. ' +
			'Set QUERY_SURFACE_PATH=<path> to run it. The emitted type mirror is NOT ' +
			'verified against the package in this run.',
	);
}

describe.skipIf(siblingRoot === null)('semantic type mirror conformance', () => {
	for (const group of MIRRORED) {
		const source = siblingRoot
			? readFileSync(resolve(siblingRoot, group.file), 'utf-8')
			: '';

		for (const name of group.types) {
			it(`${name} is a sound narrowing of the package declaration`, () => {
				const theirs = extractDeclaration(source, name);
				const ours = extractDeclaration(mirror, name);
				expect(theirs, `${name} not found in ${group.file}`).not.toBeNull();
				expect(ours, `${name} not found in the emitted mirror`).not.toBeNull();

				// Unions of string literals (Agg, Additivity, AggColType, …) and
				// type aliases have no members — compare them verbatim, modulo the
				// package's branded `EntityName`, which an emitted literal cannot
				// reference, and the named has_one expectation.
				const theirMembers = members(theirs!);
				if (Object.keys(theirMembers).length === 0) {
					let expected = theirs!.replace(/EntityName/g, 'string');
					let actual = ours!;
					if (actual.includes("'has_one'")) {
						// NAMED SINGLE-PURPOSE EXPECTATION — SEM-2 emits has_one
						// faithfully (PLAN §5.3); pre-${HAS_ONE_ISSUE} the package
						// does not know the kind. See HAS_ONE_ISSUE for the exit.
						expect(expected, `${name}: the package has has_one (${HAS_ONE_ISSUE}) — retire the mirror (SEM-4, docs/specs/SEM-2.md §4); do not edit this expectation`).not.toContain('has_one');
						actual = normalise(
							actual
								.replace(/\s*\|\s*'has_one'/, '')
								.replace(/\s*\|\s*\{ kind: 'has_one'[^}]*\}/, ''),
						);
					}
					expect(actual).toBe(expected);
					return;
				}

				const ourMembers = members(ours!);
				const omissions = TOLERATED_OMISSIONS[name] ?? {};
				const typeDiffs = TOLERATED_TYPE_DIFFERENCES[name] ?? {};

				for (const [member, theirType] of Object.entries(theirMembers)) {
					const bare = member.replace('?', '');
					if (!(member in ourMembers)) {
						expect(
							omissions[bare],
							`${name}.${bare} exists in the package but not in the mirror, and is not a documented omission`,
						).toBeDefined();
						continue;
					}
					if (typeDiffs[bare] !== undefined) continue;
					let theirNormalised = theirType.replace(/EntityName/g, 'string');
					let ourType = ourMembers[member]!;
					if (bare === 'kind' && ourType.includes("'has_one'")) {
						expect(
							theirNormalised,
							`${name}.kind has has_one (${HAS_ONE_ISSUE}) — retire the mirror (SEM-4, docs/specs/SEM-2.md §4); do not edit this expectation`,
						).not.toContain('has_one');
						ourType = normalise(ourType.replace(/\s*\|\s*'has_one'/, ''));
					}
					expect(ourType, `${name}.${bare} drifted from the package`).toBe(
						theirNormalised,
					);
				}

				for (const member of Object.keys(ourMembers)) {
					expect(
						Object.keys(theirMembers),
						`${name}.${member.replace('?', '')} is in the mirror but not in the package`,
					).toContain(member);
				}
			});
		}
	}

	it('AggregateModel declares the same members as the package', () => {
		const modelSource = readFileSync(
			resolve(siblingRoot!, 'src/adapters/drizzle/registry/model.ts'),
			'utf-8',
		);
		const theirs = Object.keys(members(extractDeclaration(modelSource, 'AggregateModel')!)).sort();
		const ours = Object.keys(members(extractDeclaration(mirror, 'AggregateModel')!)).sort();
		expect(ours).toEqual(theirs);
	});

	it('EntityDescriptor is a narrowing of the package type, never a widening', () => {
		const registrySource = readFileSync(
			resolve(siblingRoot!, 'src/adapters/drizzle/registry/registry.ts'),
			'utf-8',
		);
		const theirs = Object.keys(
			members(extractDeclaration(registrySource, 'EntityDescriptor')!),
		);
		const ours = Object.keys(members(extractDeclaration(mirror, 'EntityDescriptor')!));
		// Every member the mirror declares must exist on the package's type. The
		// converse is deliberately NOT asserted: the mirror omits members SEM-2
		// does not populate (eav / fieldMeta / computed).
		for (const member of ours) expect(theirs).toContain(member);
	});
});
