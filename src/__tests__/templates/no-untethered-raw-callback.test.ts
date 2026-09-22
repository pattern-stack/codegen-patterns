/**
 * A `RAW` callback must USE the table it is handed — REL-2 (#587).
 *
 * Drizzle's relational query builder aliases the root and every hop
 * (`from "regions" as "d0"`), and it passes that aliased handle to a `RAW`
 * callback. A callback that ignores the argument and closes over a table handle
 * from its enclosing scope renders `where "regions"."deleted_at" is null` — an
 * invalid reference to a FROM-clause entry. Postgres rejects the statement, so
 * EVERY include on a scoped entity fails to execute.
 *
 * That shipped once, in the emitted repository's root filter, and no gate caught
 * it: the HTTP scaffold mounts deliberately unscoped entities, whose root
 * predicate is `sql\`true\`` and names no column at all; the leak tests drove the
 * scoped graph through raw `db.query.*`; and the smoke only regex-matches emitted
 * text. `relation-scope.test.ts` L9–L11 now execute the real path, and
 * `hop-scope-sql.spec.ts` pins the rendered SQL — this file is the third leg: a
 * grep gate on the SHAPE, so the mistake cannot be reintroduced anywhere.
 *
 * Same form as `no-basequery-where.test.ts` (SCOPE-0, #616), and for the same
 * reason: the defect is invisible in review and expensive at runtime.
 *
 * What is NOT banned: `{ RAW: <SQLWrapper> }` — a plain pre-built predicate,
 * which is how a CALLER's own `where` is folded in. Only the zero-argument
 * CALLBACK form is wrong, because the only reason to take a callback is to
 * receive the table.
 *
 * Comments are scanned too, deliberately — the DRZ-1 guard earned that the same
 * way, and this one did on its first run: the only hit was a doc comment in
 * `scope-filters.ts` still showing the broken form. Prose that teaches the bug is
 * how the bug comes back.
 *
 * `docs/` is deliberately NOT scanned, and the review that asked the question
 * deserves the reasoning rather than a default:
 *
 *  - the subject of this gate is code that is EMITTED or SHIPPED. A spec is a
 *    design record, where quoting the broken form is the point — `REL-2.md`
 *    §10 Found #9 does exactly that, as does this file's own regex fixture
 *    below. Scanning docs would force an opt-out marker onto both, and a
 *    tripwire with an escape hatch is weaker than one with a crisp boundary;
 *  - more to the point, a grep cannot tell a counter-example from a contract.
 *    What actually drifted (REL-2.md §3 stating the un-threaded form as the
 *    current call site) reads identically to Found #9 quoting it as history, so
 *    a docs-wide scan would not have been the right instrument even pointed at
 *    the right file.
 *
 * So the one paragraph that STATES the contract gets a named, single-purpose
 * expectation instead — the last `it` below. Exact file, exact claim, no
 * predicate and no carve-out.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { globSync } from 'glob';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

/**
 * Every surface that can emit — or contain — a relational-filter callback: the
 * hygen templates, the whole-set TS emitters, the shipped runtime, and the
 * checked-in golden manifest.
 */
const SCANNED = [
	'templates/**/*.{t,js,mjs,ejs}',
	'src/emitters/**/*.ts',
	'src/cli/shared/**/*.ts',
	'runtime/**/*.ts',
	'test/relations-golden/snapshot/*.ts',
];

/** `RAW: () =>` / `RAW: ()=>`, with any whitespace. */
const UNTETHERED = /\bRAW\s*:\s*\(\s*\)\s*=>/;

function scan(): string[] {
	const offenders: string[] = [];
	for (const pattern of SCANNED) {
		for (const file of globSync(pattern, { cwd: REPO_ROOT, nodir: true })) {
			const abs = join(REPO_ROOT, file);
			const lines = readFileSync(abs, 'utf8').split('\n');
			for (const [index, line] of lines.entries()) {
				if (UNTETHERED.test(line)) {
					offenders.push(`${relative(REPO_ROOT, abs)}:${index + 1}: ${line.trim()}`);
				}
			}
		}
	}
	return offenders;
}

describe('a RAW callback must take the table it renders against', () => {
	it('no emitted or shipped file uses the zero-argument RAW callback form', () => {
		const offenders = scan();
		expect(
			offenders,
			`A \`RAW: () => …\` callback ignores the ALIASED table the relational query ` +
				`builder hands it, so the predicate it returns names the base table and ` +
				`Postgres rejects the statement. Take the table: \`RAW: (t) => …\`.\n\n` +
				offenders.join('\n'),
		).toEqual([]);
	});

	it('the scan actually reaches the files it claims to (guard against an empty sweep)', () => {
		// A tripwire whose glob silently matched nothing is worse than no tripwire.
		const manifestEmitter = readFileSync(
			join(REPO_ROOT, 'src/emitters/relations/emit-manifest.ts'),
			'utf8',
		);
		expect(manifestEmitter).toContain('RAW: (t) =>');

		const repositoryTemplate = readFileSync(
			join(REPO_ROOT, 'templates/entity/new/backend/repository.ejs.t'),
			'utf8',
		);
		expect(repositoryTemplate).toContain('RAW: (t) => this.rootScopeRawOn(t,');
	});

	// The spec paragraph that states the contract, pinned by name. Not a docs-wide
	// scan — see the header for why — just the one place a reader looks up what the
	// call site is, which is the place it drifted.
	it('REL-2 §3 states the THREADED form as call site 2', () => {
		const spec = readFileSync(join(REPO_ROOT, 'docs/specs/REL-2.md'), 'utf8');
		const heading = '## §3 One predicate builder, three call sites';
		expect(spec, 'REL-2.md lost the §3 heading this expectation is anchored to').toContain(
			heading,
		);

		const section = spec.slice(spec.indexOf(heading), spec.indexOf('## §4'));
		const callSiteTwo = section
			.split('\n')
			.find((line) => line.startsWith('2. The generated repository'));
		expect(callSiteTwo, 'REL-2.md §3 lost its numbered call site 2').toBeDefined();
		expect(callSiteTwo!).toContain('RAW: (t) => this.rootScopeRawOn(t,');
		expect(callSiteTwo!).not.toMatch(UNTETHERED);
	});

	it('catches the shape it is for', () => {
		// The exact line REL-2 §3 carried before the re-review caught it — kept as the
		// regex's positive fixture so the ban is pinned to a real string.
		expect(UNTETHERED.test('{ RAW: () => this.rootScopeRaw({ softDelete: true }) },')).toBe(true);
		expect(
			UNTETHERED.test(
				'2. The generated repository\'s RQBv2 root filter — `{ RAW: () => this.rootScopeRaw({ softDelete }) }`',
			),
		).toBe(true);
		expect(UNTETHERED.test('{ RAW: ()=>x },')).toBe(true);
		// …and leaves the legitimate forms alone.
		expect(UNTETHERED.test('{ RAW: (t) => hopScope(t, CFG, "a.b") },')).toBe(false);
		expect(UNTETHERED.test('{ RAW: callerWhere },')).toBe(false);
	});
});
