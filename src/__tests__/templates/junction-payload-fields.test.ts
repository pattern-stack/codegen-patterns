/**
 * Junction payload fields are entity fields (#740, #690) and the base columns
 * can be opted out of (dealbrain dogfood #7, #8).
 *
 * Runs the real prompt.js + the junction's entity / service / repository
 * templates in a temp project, so the assertions are on emitted source.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ejs from 'ejs';
import junctionPrompt from '../../../templates/junction/new/prompt.js';

function render(template: string, locals: Record<string, unknown>): string {
	const source = fs.readFileSync(
		path.resolve(import.meta.dir, `../../../templates/junction/new/${template}.ejs.t`),
		'utf8',
	);
	return ejs.render(source.replace(/^---\n[\s\S]*?\n---\n/, ''), locals, { rmWhitespace: false });
}

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function junctionLocals(body: string): Promise<Record<string, any>> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-payload-'));
	tmpDirs.push(dir);
	fs.mkdirSync(path.join(dir, 'entities'));
	fs.writeFileSync(path.join(dir, 'entities', 'opportunity.yaml'), 'entity:\n  name: opportunity\n  plural: opportunities\n');
	fs.writeFileSync(path.join(dir, 'entities', 'meeting.yaml'), 'entity:\n  name: meeting\n  plural: meetings\n');
	fs.writeFileSync(path.join(dir, 'entities', 'account.yaml'), 'entity:\n  name: account\n  plural: accounts\n');
	fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), '');
	const file = path.join(dir, 'junction.yaml');
	fs.writeFileSync(file, `pattern: Junction\nbetween: [opportunity, meeting]\n${body}`);
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		return (await junctionPrompt.prompt({ args: { yaml: file } })) as Record<string, any>;
	} finally {
		process.chdir(cwd);
	}
}

describe('junction payload fields use the entity column builder (#740)', () => {
	it('honours required, nullable + default, foreign_key and index', async () => {
		const out = render(
			'entity',
			await junctionLocals(
				[
					'fields:',
					'  source: { type: string, required: true }',
					'  weight: { type: integer, nullable: false, default: 0 }',
					'  account_id: { type: uuid, foreign_key: accounts.id, index: true }',
				].join('\n'),
			),
		);
		expect(out).toContain("source: text('source').notNull(),");
		expect(out).toContain("weight: integer('weight').notNull().default(0),");
		expect(out).toContain(
			"accountId: uuid('account_id').references((): AnyPgColumn => accounts.id),",
		);
		expect(out).toContain("import { accounts } from '../accounts/account.entity';");
		expect(out).toContain(
			"index('opportunity_meetings_account_id_idx').on(table.accountId),",
		);
		expect(out).toMatch(/\n {2}index,\n/);
	});

	// A payload column is only usable if `attach` can write it: a `required: true`
	// field is NOT NULL with no default, so it must be in `LinkInput` and the
	// link argument must be required — or every attach fails with 23502.
	it('puts payload fields in LinkInput; a required one makes the link argument required', async () => {
		const service = render(
			'service',
			await junctionLocals(
				'temporal: false\nsourced: false\nfields:\n  source: { type: string, required: true }\n  weight: { type: integer }\n',
			),
		);
		expect(service).toContain(
			"globalThis.Pick<OpportunityMeeting,\n    'isPrimary' | 'weight'\n  >\n> & globalThis.Pick<OpportunityMeeting, 'source'>;",
		);
		expect(service).toContain('link: OpportunityMeetingLinkInput,');
		const optional = render('service', await junctionLocals('fields:\n  weight: { type: integer }\n'));
		expect(optional).toContain('link?: OpportunityMeetingLinkInput,');
		expect(optional).not.toContain('> & globalThis.Pick');
	});

	it('emits a role without choices as a plain column outside the key (dogfood #7)', async () => {
		const out = render('entity', await junctionLocals('fields:\n  role: { type: string }\n'));
		expect(out).toContain("role: text('role'),");
		expect(out).toContain('primaryKey({ columns: [table.opportunityId, table.meetingId] })');
		expect(out).not.toContain('pgEnum(');
	});

	it('refuses `values:` instead of silently dropping the role (#690)', async () => {
		await expect(
			junctionLocals('fields:\n  role: { type: enum, values: [a, b] }\n'),
		).rejects.toThrow("junction field 'role'");
	});
});

describe('junction base-column opt-outs (dogfood #8)', () => {
	it('is_primary: false drops the column, setPrimary and the LinkInput key', async () => {
		const locals = await junctionLocals('temporal: false\nsourced: false\nis_primary: false\n');
		expect(render('entity', locals)).not.toContain('is_primary');
		const service = render('service', locals);
		expect(service).not.toContain('setPrimary');
		expect(service).toContain('globalThis.Pick<OpportunityMeeting,\n    never\n  >');
	});

	it('timestamps: false drops created_at / updated_at and turns write stamping off', async () => {
		const locals = await junctionLocals('timestamps: false\n');
		expect(render('entity', locals)).not.toContain('created_at');
		const repo = render('repository', locals);
		expect(repo).toContain('timestamps: false,');
		expect(repo).not.toContain('createdAt');
	});

	it('the defaults keep every base column', async () => {
		const locals = await junctionLocals('');
		const entity = render('entity', locals);
		expect(entity).toContain("isPrimary: boolean('is_primary').notNull().default(false),");
		expect(entity).toContain("createdAt: timestamp('created_at'");
		expect(render('service', locals)).toContain('async setPrimary(');
		expect(render('repository', locals)).toContain('timestamps: true,');
	});
});
