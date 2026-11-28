/**
 * The pattern-stack composition refuses a cycle between the modules it builds (PW-3a), the root `entities` module
 * included: an entity with no `context:` is composed in `entities`, so a context entity and a root entity that
 * compose each other's repositories make `crm` and `entities` depend on each other.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadProjectApiContext } from '../../../derived/api/project';
import { planComposition } from '../../../emitters/composition/emit-composition';

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function plan(files: Record<string, string>, junctions: Record<string, string> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'module-cycles-'));
	dirs.push(root);
	fs.mkdirSync(path.join(root, 'entities'));
	fs.mkdirSync(path.join(root, 'junctions'));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'entities', name), text);
	for (const [name, text] of Object.entries(junctions)) fs.writeFileSync(path.join(root, 'junctions', name), text);
	const relations = loadProjectApiContext(root, null, {
		entitiesDir: path.join(root, 'entities'),
		junctionsDir: path.join(root, 'junctions'),
		relationshipsDir: path.join(root, 'relationships'),
	}).relations;
	return () =>
		planComposition({
			relations,
			modulesDir: path.join(root, 'src/modules'),
			generatedDir: path.join(root, 'src/generated'),
			drizzleTypeImport: '@shared/types/drizzle',
			commandsImport: '@shared/commands',
			banner: '// @generated',
			dryRun: true,
		});
}

const user = (hasMany: boolean) =>
	[
		'entity:',
		'  name: user',
		'  plural: users',
		'fields:',
		'  name:',
		'    type: string',
		...(hasMany ? ['relationships:', '  contacts:', '    type: has_many', '    target: contact', '    foreign_key: user_id'] : []),
		'',
	].join('\n');
const contact = [
	'entity:',
	'  name: contact',
	'  plural: contacts',
	'  context: crm',
	'fields:',
	'  user_id:',
	'    type: uuid',
	'    foreign_key: users.id',
	'relationships:',
	'  user:',
	'    type: belongs_to',
	'    target: user',
	'    foreign_key: user_id',
	'',
].join('\n');

describe('module cycles', () => {
	it('refuses a context module and the root module that compose each other, naming both', () => {
		const run = plan({ 'user.yaml': user(true), 'contact.yaml': contact });
		expect(run).toThrow('modules must depend on each other one way');
		expect(run).toThrow(/crm → entities → crm|entities → crm → entities/);
	});

	it('composes the same pair when only one side composes the other', () => {
		const files = plan({ 'user.yaml': user(false), 'contact.yaml': contact })();
		const crm = files.find((f) => f.path.endsWith('/modules/crm/module.ts'))!.content;
		expect(crm).toContain("dependsOn: ['entities']");
	});

	it('names no junction when the cycle is the entities\' own (PW-3c): removing the junction would not fix it', () => {
		// crm ↔ billing through entity edges alone (account has_many invoice, invoice belongs_to account); the one-sided
		// junction sits in billing and adds only billing → crm.
		const account = [
			'entity:',
			'  name: account',
			'  plural: accounts',
			'  context: crm',
			'fields:',
			'  name:',
			'    type: string',
			'relationships:',
			'  invoices:',
			'    type: has_many',
			'    target: invoice',
			'    foreign_key: account_id',
			'',
		].join('\n');
		const invoice = [
			'entity:',
			'  name: invoice',
			'  plural: invoices',
			'  context: billing',
			'fields:',
			'  account_id:',
			'    type: uuid',
			'    foreign_key: accounts.id',
			'relationships:',
			'  account:',
			'    type: belongs_to',
			'    target: account',
			'    foreign_key: account_id',
			'',
		].join('\n');
		const run = plan(
			{ 'account.yaml': account, 'invoice.yaml': invoice },
			{ 'invoice_account.yaml': 'pattern: Junction\nbetween: [invoice, account]\nexpose_on_parent:\n  left: true\n  right: false\n' },
		);
		expect(run).toThrow('modules must depend on each other one way');
		let message = '';
		try {
			run();
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).not.toContain('a junction across two modules');
	});

	it('refuses a context named like a generated system (auth, connections, events…): compose() would throw at boot', () => {
		for (const name of ['auth', 'connections', 'events', 'settings']) {
			const entity = `entity:\n  name: thing\n  plural: things\n  context: ${name}\nfields:\n  label:\n    type: string\n`;
			expect(plan({ 'thing.yaml': entity })).toThrow(`context '${name}' (entity 'thing') would be the module '${name}'`);
		}
	});
});
