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
 * READ-1 (#840) banned the SECOND shape: `{ RAW: <SQL value> }` — a pre-built
 * predicate handed to a relational filter. REL-2 left it allowed as "how a
 * caller's own `where` is folded in", and that is exactly the defect: a caller's
 * SQL was built against the real table, so `list({ where, with })` failed with
 * the same FROM-clause error the root filter had (the third instance of the
 * class). On an aliased statement a `RAW` slot takes a callback that receives the
 * table, or `this.rootFilter(…)` — which returns one — and nothing else.
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

/**
 * READ-1 (#840): `RAW: <value>` — anything that is neither an ARROW callback
 * (`(…) =>`) nor the repository's root filter, which returns one. A pre-rendered
 * SQL in a relational filter names the real table, which the builder aliased
 * away. A parenthesised value (`RAW: (callerWhere)`) is a value, not a callback.
 */
const PRERENDERED = /\bRAW\s*:\s*(?!\([^()]*\)\s*=>|this\.rootFilter\()[A-Za-z_$(]/;

/**
 * READ-1 review #6 — the shapes of the SAME defect at the call site READ-1 moved
 * every root predicate to, `rootFilter`'s argument:
 *  - a zero-argument callback (`rootFilter(() => …)`), which can only be closing
 *    over a table it was not handed;
 *  - a callback that names this repository's own handle (`this.table`,
 *    `this.tableRef`, `this.col(`) or the table export (`<%= entityNamePlural %>.`)
 *    inside a `rootFilter(` / `RAW:` line — the relational builder aliased that
 *    table away;
 *  - a `RAW:` whose value is on the NEXT line, which the line-based checks above
 *    cannot see — so it is banned as a shape.
 */
const ROOTFILTER_UNTETHERED = /\brootFilter\(\s*\(\s*\)\s*=>/;
const OWN_HANDLE_IN_CALLBACK =
	/(\brootFilter\(|\bRAW\s*:).*(\bthis\.(table|tableRef)\b|\bthis\.col\(|<%= *entityNamePlural *%>\.)/;
const RAW_VALUE_ON_NEXT_LINE = /\bRAW\s*:\s*$/;

/** The own-handle names, for the multi-line check below. */
const OWN_HANDLE = /\bthis\.(table|tableRef)\b|\bthis\.col\(|<%= *entityNamePlural *%>\./;

/**
 * The full ARGUMENT of every `rootFilter(` call, however many lines it spans —
 * balanced parentheses from the call's `(`. The line checks above only see the
 * first line, so a callback whose body continues on the next one
 * (`rootFilter((t) =>\n  eq(this.table.id, id))`) passed them (review nit).
 * Capped so an unbalanced mention in prose cannot swallow a file.
 */
function rootFilterArguments(text: string): Array<{ offset: number; arg: string }> {
	const out: Array<{ offset: number; arg: string }> = [];
	const call = /\brootFilter\(/g;
	for (let m = call.exec(text); m !== null; m = call.exec(text)) {
		const start = m.index + m[0].length;
		let depth = 1;
		let i = start;
		for (; i < text.length && i < start + 600 && depth > 0; i++) {
			if (text[i] === '(') depth++;
			else if (text[i] === ')') depth--;
		}
		out.push({ offset: m.index, arg: text.slice(start, i - 1) });
	}
	return out;
}

function scan(): string[] {
	const offenders: string[] = [];
	for (const pattern of SCANNED) {
		for (const file of globSync(pattern, { cwd: REPO_ROOT, nodir: true })) {
			const abs = join(REPO_ROOT, file);
			const text = readFileSync(abs, 'utf8');
			for (const { offset, arg } of rootFilterArguments(text)) {
				if (OWN_HANDLE.test(arg)) {
					const line = text.slice(0, offset).split('\n').length;
					offenders.push(`${relative(REPO_ROOT, abs)}:${line}: rootFilter(${arg.replace(/\s+/g, ' ').trim()})`);
				}
			}
			const lines = text.split('\n');
			for (const [index, line] of lines.entries()) {
				if (
					UNTETHERED.test(line) ||
					PRERENDERED.test(line) ||
					ROOTFILTER_UNTETHERED.test(line) ||
					OWN_HANDLE_IN_CALLBACK.test(line) ||
					RAW_VALUE_ON_NEXT_LINE.test(line)
				) {
					offenders.push(`${relative(REPO_ROOT, abs)}:${index + 1}: ${line.trim()}`);
				}
			}
		}
	}
	return offenders;
}

describe('a RAW callback must take the table it renders against', () => {
	it('no emitted or shipped file uses the zero-argument or the pre-rendered RAW form', () => {
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
		expect(repositoryTemplate).toContain('where: { RAW: this.rootFilter(');
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
		expect(callSiteTwo!).toContain('RAW: this.rootFilter(');
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

	it('catches the rootFilter-argument forms of the defect (review #6), and leaves the threaded form alone', () => {
		// M1 from the review — green on every unit gate before this, red only in Docker.
		expect(ROOTFILTER_UNTETHERED.test('where: { RAW: this.rootFilter(() => eq(this.table.id, id)) },')).toBe(true);
		expect(OWN_HANDLE_IN_CALLBACK.test('where: { RAW: this.rootFilter(() => eq(this.table.id, id)) },')).toBe(true);
		expect(OWN_HANDLE_IN_CALLBACK.test("where: { RAW: this.rootFilter((t) => eq(this.col('id'), id)) },")).toBe(true);
		expect(
			OWN_HANDLE_IN_CALLBACK.test('where: { RAW: this.rootFilter((t) => eq(<%= entityNamePlural %>.id, id)) },'),
		).toBe(true);
		// M2 — a RAW that ignores its table and reaches for the core builder's guard.
		expect(OWN_HANDLE_IN_CALLBACK.test('{ RAW: (_t) => this.scopeAnd(query?.where?.(this.table)) ?? sql`true` },')).toBe(true);
		// M3 — the value moved to the next line.
		expect(RAW_VALUE_ON_NEXT_LINE.test('      where: { RAW:')).toBe(true);
		// The shipped forms pass.
		for (const ok of [
			'where: { RAW: this.rootFilter((t) => eq(t.id, id)) },',
			'where: { RAW: this.rootFilter(query?.where) },',
			"where: { RAW: (t) => hopScope(t, ACCOUNTS_SCOPE, 'contacts.account') } }),",
		]) {
			expect(ROOTFILTER_UNTETHERED.test(ok) || OWN_HANDLE_IN_CALLBACK.test(ok) || RAW_VALUE_ON_NEXT_LINE.test(ok)).toBe(false);
		}
	});

	it('reads a multi-line rootFilter argument whole (review nit)', () => {
		const multi = 'where: { RAW: this.rootFilter((t) =>\n      and(eq(t.id, id), eq(this.table.name, n))) },';
		expect(multi.split('\n').some((l) => OWN_HANDLE_IN_CALLBACK.test(l))).toBe(false); // the line check misses it
		expect(rootFilterArguments(multi).some(({ arg }) => OWN_HANDLE.test(arg))).toBe(true);
		const ok = 'where: { RAW: this.rootFilter((t) =>\n      and(eq(t.id, id), eq(t.name, n))) },';
		expect(rootFilterArguments(ok).some(({ arg }) => OWN_HANDLE.test(arg))).toBe(false);
	});

	it('catches the pre-rendered form READ-1 banned, and leaves the callback forms alone', () => {
		expect(PRERENDERED.test('{ RAW: (callerWhere) },')).toBe(true);
		expect(PRERENDERED.test('{ RAW: (t: PgTable) => hopScope(t, CFG, "a.b") },')).toBe(false);
		// The exact line the generated `list()` carried before #840.
		expect(PRERENDERED.test('...(callerWhere === undefined ? [] : [{ RAW: callerWhere }]),')).toBe(true);
		expect(PRERENDERED.test('{ RAW: sql`true` },')).toBe(true);
		expect(PRERENDERED.test('{ RAW: inArray(accounts.id, ids) },')).toBe(true);
		expect(PRERENDERED.test('where: { RAW: this.rootFilter((t) => eq(t.id, id)) },')).toBe(false);
		expect(PRERENDERED.test('{ RAW: (t) => hopScope(t, CFG, "a.b") },')).toBe(false);
		expect(PRERENDERED.test('RAW?: SQLWrapper | ((table) => SQL)')).toBe(false);
	});
});
