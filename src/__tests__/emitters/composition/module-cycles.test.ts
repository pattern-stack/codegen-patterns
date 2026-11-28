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

function plan(files: Record<string, string>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'module-cycles-'));
	dirs.push(root);
	fs.mkdirSync(path.join(root, 'entities'));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'entities', name), text);
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
});
