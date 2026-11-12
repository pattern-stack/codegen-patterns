import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertTimestampColumns, collectTimezoneOptOuts } from '../../../test/smoke/_timestamp-columns';

const TZ = "{ withTimezone: true, mode: 'date' }";
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function modules(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-scan-'));
	dirs.push(dir);
	for (const [name, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), body);
	}
	return dir;
}

const entity = (cols: string) =>
	`import { pgTable, timestamp } from 'drizzle-orm/pg-core';\nexport const things = pgTable('things', {\n${cols}\n});\n`;

describe('assertTimestampColumns (#796)', () => {
	it('passes tz calls and a declared opt-out', () => {
		const dir = modules({
			'things/thing.entity.ts': entity(`  a: timestamp('a', ${TZ}).notNull(),\n  b: timestamp('b'),`),
		});
		expect(assertTimestampColumns(dir, new Set(['things.b']))).toEqual({ files: 1, calls: 2 });
	});

	const bad: Record<string, [string, string[]]> = {
		'a bare call': [`  a: timestamp('a'),`, []],
		'mode alone': [`  a: timestamp('a', { mode: 'date' }),`, []],
		'extra options': [`  a: timestamp('a', { withTimezone: true, mode: 'date', precision: 3 }),`, []],
		'double quotes': [`  a: timestamp("a", ${TZ}),`, []],
		'an unparseable call': [`  a: timestamp(col),`, []],
		'an opt-out emitted with tz': [`  a: timestamp('a', ${TZ}),`, ['things.a']],
		'an opt-out never emitted': [`  a: timestamp('a', ${TZ}),`, ['things.zzz']],
	};
	for (const [name, [cols, optOuts]] of Object.entries(bad)) {
		it(`throws on ${name}`, () => {
			const dir = modules({ 'things/thing.entity.ts': entity(cols) });
			expect(() => assertTimestampColumns(dir, new Set(optOuts))).toThrow();
		});
	}

	it('throws when no entity file exists, or no timestamp call', () => {
		expect(() => assertTimestampColumns(modules({ 'x.ts': '' }), new Set())).toThrow(/no \*\.entity\.ts/);
		expect(() =>
			assertTimestampColumns(modules({ 'a/a.entity.ts': 'export const a = 1;\n' }), new Set()),
		).toThrow(/no timestamp\(/);
	});
});

describe('collectTimezoneOptOuts (#796)', () => {
	it('names table.column from the YAML, and refuses an opt-out it cannot place', () => {
		const dir = modules({
			'e.yaml': 'entity:\n  name: a\n  plural: as\n  table: a_tbl\nfields:\n  x:\n    type: datetime\n    timezone: false\n',
			'r.yaml': 'relationship:\n  name: r\n  table: r_tbl\nfields:\n  y:\n    type: datetime\n    timezone: false\n',
			'j.yaml': 'pattern: Junction\nfields:\n  z:\n    type: datetime\n    timezone: false\n',
			'none.yaml': 'entity:\n  name: n\n  plural: ns\nfields:\n  q:\n    type: datetime\n',
		});
		const p = (n: string) => path.join(dir, n);
		expect([...collectTimezoneOptOuts([p('e.yaml'), p('r.yaml'), p('none.yaml')], '', true)].sort()).toEqual([
			'a_tbl.x',
			'r_tbl.y',
		]);
		expect(() => collectTimezoneOptOuts([p('j.yaml')], '', true)).toThrow(/cannot be named/);
	});

	it('names the columns of a timestamp behavior switched off on the entity or the project (#845)', () => {
		const dir = modules({
			'off.yaml':
				'entity:\n  name: o\n  plural: os\nfields: {}\nbehaviors:\n' +
				'  - name: timestamps\n    options: { timezone: false }\n  - soft_delete\n',
			'on.yaml':
				'entity:\n  name: n\n  plural: ns\nfields: {}\nbehaviors:\n' +
				'  - timestamps\n  - name: soft_delete\n    options: { timezone: true }\n',
		});
		const p = (n: string) => path.join(dir, n);
		expect([...collectTimezoneOptOuts([p('off.yaml'), p('on.yaml')], '', true)].sort()).toEqual([
			'os.created_at',
			'os.updated_at',
		]);
		// Project default off: every timestamp behavior column is bare unless the entity turns it back on.
		expect([...collectTimezoneOptOuts([p('off.yaml'), p('on.yaml')], '', false)].sort()).toEqual([
			'ns.created_at',
			'ns.updated_at',
			'os.created_at',
			'os.deleted_at',
			'os.updated_at',
		]);
	});

	it('with the project default off, names the time columns a junction / relationship emits itself (#845)', () => {
		const dir = modules({
			'j.yaml': 'pattern: Junction\nbetween: [opportunity, contact]\n',
			'jlean.yaml': 'pattern: Junction\nbetween: [opportunity, meeting]\ntemporal: false\nsourced: false\n',
			'r.yaml': 'relationship:\n  name: r\n  table: r_tbl\n',
			'jbare.yaml': 'pattern: Junction\nbetween: [opportunity, account]\ntemporal: false\nsourced: false\ntimestamps: false\n',
		});
		const p = (n: string) => path.join(dir, n);
		const files = [p('j.yaml'), p('jlean.yaml'), p('r.yaml'), p('jbare.yaml')];
		expect([...collectTimezoneOptOuts(files, '', true)]).toEqual([]);
		expect([...collectTimezoneOptOuts(files, '', false)].sort()).toEqual([
			'opportunity_contacts.created_at',
			'opportunity_contacts.ended_at',
			'opportunity_contacts.matched_at',
			'opportunity_contacts.started_at',
			'opportunity_contacts.updated_at',
			'opportunity_meetings.created_at',
			'opportunity_meetings.updated_at',
			'r_tbl.created_at',
			'r_tbl.updated_at',
		]);
	});
});
