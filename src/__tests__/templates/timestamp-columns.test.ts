/**
 * #796 — junction and relationship tables emit every time column as
 * `timestamp with time zone`; `timezone: false` on a payload field opts that
 * column out, and `timezone:` on a non-datetime field is refused.
 *
 * Runs the real prompt.js + entity.ejs.t in a temp project.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ejs from 'ejs';
import junctionPrompt from '../../../templates/junction/new/prompt.js';
import relationshipPrompt from '../../../templates/relationship/new/prompt.js';
import { TIMEZONE_NOT_BOOLEAN_MESSAGE, TIMEZONE_ON_NON_DATETIME_MESSAGE } from '../../schema/field-timestamp';

const TZ = "{ withTimezone: true, mode: 'date' }";

function render(kind: 'junction' | 'relationship', locals: Record<string, unknown>): string {
	const source = fs.readFileSync(
		path.resolve(import.meta.dir, `../../../templates/${kind}/new/entity.ejs.t`),
		'utf8',
	);
	return ejs.render(source.replace(/^---\n[\s\S]*?\n---\n/, ''), locals, { rmWhitespace: false });
}

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timestamp-cols-'));
	tmpDirs.push(dir);
	fs.mkdirSync(path.join(dir, 'entities'));
	fs.writeFileSync(path.join(dir, 'entities', 'player.yaml'), 'entity:\n  name: player\n  plural: players\n');
	fs.writeFileSync(path.join(dir, 'entities', 'team.yaml'), 'entity:\n  name: team\n  plural: teams\n');
	fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), '');
	return dir;
}

async function inProject<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		return await fn();
	} finally {
		process.chdir(cwd);
	}
}

async function junctionLocals(fieldsYaml: string): Promise<Record<string, any>> {
	const dir = project();
	const file = path.join(dir, 'junction.yaml');
	fs.writeFileSync(
		file,
		`pattern: Junction\nbetween: [player, team]\ntemporal: true\nsourced: true\nfields:\n${fieldsYaml}`,
	);
	return inProject(dir, async () => (await junctionPrompt.prompt({ args: { yaml: file } })) as Record<string, any>);
}

async function relationshipLocals(fieldsYaml: string): Promise<Record<string, any>> {
	const dir = project();
	const file = path.join(dir, 'def.yaml');
	fs.writeFileSync(
		file,
		`relationship:\n  name: player_team\n  from: player\n  to: team\nfields:\n${fieldsYaml}`,
	);
	return inProject(
		dir,
		async () => (await relationshipPrompt.prompt({ args: { yaml: file } })) as Record<string, any>,
	);
}

const FIELDS =
	'  last_contacted_at:\n    type: datetime\n  opens_at:\n    type: datetime\n    timezone: false\n';

describe('junction time columns (#796)', () => {
	it('every time column is timestamptz; only the declared opt-out is bare', async () => {
		const out = render('junction', await junctionLocals(FIELDS));
		for (const col of ['started_at', 'ended_at', 'matched_at']) {
			expect(out).toContain(`timestamp('${col}', ${TZ})`);
		}
		expect(out).toContain(`timestamp('created_at', ${TZ}).notNull().defaultNow()`);
		expect(out).toContain(`timestamp('updated_at', ${TZ}).notNull().defaultNow()`);
		expect(out).toContain(`lastContactedAt: timestamp('last_contacted_at', ${TZ}),`);
		expect(out).toContain("opensAt: timestamp('opens_at'),");
		expect([...out.matchAll(/timestamp\('(\w+)'\)/g)].map((m) => m[1])).toEqual(['opens_at']);
	});

	it('refuses timezone: on a non-datetime payload field', async () => {
		await expect(junctionLocals('  note:\n    type: string\n    timezone: false\n')).rejects.toThrow(
			`[codegen] junction field 'note': ${TIMEZONE_ON_NON_DATETIME_MESSAGE}`,
		);
	});
});

describe('relationship time columns (#796)', () => {
	it('created_at / updated_at and datetime payload fields are timestamptz; the opt-out is bare', async () => {
		const out = render('relationship', await relationshipLocals(FIELDS));
		expect(out).toContain(`timestamp('created_at', ${TZ}).notNull().defaultNow()`);
		expect(out).toContain(`timestamp('updated_at', ${TZ}).notNull().defaultNow()`);
		expect(out).toContain(`lastContactedAt: timestamp('last_contacted_at', ${TZ}),`);
		expect(out).toContain("opensAt: timestamp('opens_at'),");
		expect([...out.matchAll(/timestamp\('(\w+)'\)/g)].map((m) => m[1])).toEqual(['opens_at']);
	});

	it('refuses timezone: on a non-datetime payload field', async () => {
		await expect(relationshipLocals('  note:\n    type: string\n    timezone: false\n')).rejects.toThrow(
			`[codegen] relationship field 'note': ${TIMEZONE_ON_NON_DATETIME_MESSAGE}`,
		);
	});
});

describe('non-boolean timezone: is refused (#796)', () => {
	for (const bad of ['"no"', '0']) {
		const yamlField = `  opens_at:\n    type: datetime\n    timezone: ${bad}\n`;
		it(`junction rejects timezone: ${bad}`, async () => {
			await expect(junctionLocals(yamlField)).rejects.toThrow(
				`[codegen] junction field 'opens_at': ${TIMEZONE_NOT_BOOLEAN_MESSAGE}`,
			);
		});
		it(`relationship rejects timezone: ${bad}`, async () => {
			await expect(relationshipLocals(yamlField)).rejects.toThrow(
				`[codegen] relationship field 'opens_at': ${TIMEZONE_NOT_BOOLEAN_MESSAGE}`,
			);
		});
	}
});
