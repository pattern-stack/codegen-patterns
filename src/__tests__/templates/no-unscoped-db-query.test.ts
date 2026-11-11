/**
 * Every relational read this repository EMITS or SHIPS carries the root scope —
 * READ-1 §5.3 (review #5).
 *
 * The relations manifest scopes every HOP of a `db.query.<table>` read; nothing
 * scopes its ROOT except the caller. So inside this repository a
 * `db.query.<t>.findFirst/findMany(` call must be a generated read whose root
 * `where` is `{ RAW: this.rootFilter(…) }` — checked on the line that follows the
 * call — or be named in {@link ALLOWED} with the reason it does not need one.
 * A dynamic `db.query[…]` is banned outright: it cannot be checked.
 *
 * Consumer code is out of reach of any generator gate; for that the rule is
 * documented (consumer skill `entities/families-and-queries.md`) and the typed
 * `rootScope.<table>(owner)` makes doing it right the easy path. Making it
 * structural is #844.
 *
 * Comments are skipped (a doc line that names `db.query.<table>` is prose).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { globSync } from 'glob';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

const SCANNED = [
	'templates/**/*.{t,js,mjs,ejs}',
	'src/emitters/**/*.ts',
	'src/cli/shared/**/*.ts',
	'runtime/**/*.ts',
];

/** `file:line` → why that relational read needs no root scope. None today. */
const ALLOWED: Record<string, string> = {};

const CALL = /\.query\.[\w<%=\s>]+?\.find(First|Many)\(/;
const DYNAMIC = /\bdb\.query\s*\[/;
const ROOT_SCOPED = /^\s*where: \{ RAW: this\.rootFilter\(/;
const COMMENT = /^\s*(\*|\/\/|\/\*)/;

interface Hit {
	at: string;
	line: string;
	scoped: boolean;
	dynamic: boolean;
}

function scan(): Hit[] {
	const hits: Hit[] = [];
	for (const pattern of SCANNED) {
		for (const file of globSync(pattern, { cwd: REPO_ROOT, nodir: true })) {
			const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n');
			for (const [i, line] of lines.entries()) {
				if (COMMENT.test(line)) continue;
				const dynamic = DYNAMIC.test(line);
				if (!CALL.test(line) && !dynamic) continue;
				hits.push({
					at: `${relative(REPO_ROOT, join(REPO_ROOT, file))}:${i + 1}`,
					line: line.trim(),
					scoped: !dynamic && ROOT_SCOPED.test(lines[i + 1] ?? ''),
					dynamic,
				});
			}
		}
	}
	return hits;
}

describe('every relational read in emitted/shipped code is root-scoped (READ-1 §5.3)', () => {
	const hits = scan();

	it('each db.query.<t>.find*( is followed by `where: { RAW: this.rootFilter(` — or is allowlisted', () => {
		const offenders = hits.filter((h) => !h.scoped && !(h.at in ALLOWED));
		expect(
			offenders.map((h) => `${h.at}: ${h.line}`),
			'A relational read without the repository root filter is root-UNSCOPED: the manifest ' +
				'scopes its hops, nothing scopes its root. Put `where: { RAW: this.rootFilter(…) }` on the ' +
				'line after the call, or allowlist it here with the reason.',
		).toEqual([]);
	});

	it('the sweep reaches the generated repository (guard against an empty scan)', () => {
		expect(hits.filter((h) => h.at.startsWith('templates/entity/new/backend/repository.ejs.t')).length).toBe(6);
	});

	it('every allowlist entry still names a real hit (no stale exemptions)', () => {
		for (const at of Object.keys(ALLOWED)) expect(hits.map((h) => h.at)).toContain(at);
	});

	it('catches the shapes it is for', () => {
		expect(CALL.test('const rows = await this.db.query.<%= entityNamePlural %>.findMany({')).toBe(true);
		expect(CALL.test('await db.query.accounts.findFirst({')).toBe(true);
		expect(DYNAMIC.test("await (this.db.query as never)['accounts']")).toBe(false);
		expect(DYNAMIC.test("db.query[key].findMany({})")).toBe(true);
		expect(ROOT_SCOPED.test('      where: { RAW: this.rootFilter((t) => eq(t.id, id)) },')).toBe(true);
		expect(ROOT_SCOPED.test('      where: { id: { eq: id } },')).toBe(false);
	});
});
