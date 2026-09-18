/**
 * NAME-0 (#611) — `junction new` names both endpoints from their own entity
 * YAMLs (`plural:`, `context:`), the way the endpoints' own emission does and
 * the way the relations manifest resolves parent tables — never
 * `pluralize(endpoint)`.
 *
 * Runs the real prompt.js in a temp project whose `entities/` holds:
 *   - `crew` — `context: org`, so its folder is `src/modules/org/crews/`;
 *   - `person` — `plural: persons`, where `pluralize('person')` is `people`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ejs from 'ejs';
import promptModule from '../../../templates/junction/new/prompt.js';

const TEMPLATES = path.resolve(import.meta.dir, '../../../templates/junction/new');

function render(template: string, locals: Record<string, unknown>): string {
	const source = fs.readFileSync(path.join(TEMPLATES, template), 'utf8');
	const body = source.replace(/^---\n[\s\S]*?\n---\n/, '');
	return ejs.render(body, locals, { rmWhitespace: false });
}

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function junctionLocals(
	between: [string, string],
	entities: Record<string, string>,
	config?: string,
): Promise<Record<string, any>> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-naming-'));
	tmpDirs.push(dir);
	fs.mkdirSync(path.join(dir, 'entities'));
	for (const [name, body] of Object.entries(entities)) {
		fs.writeFileSync(path.join(dir, 'entities', `${name}.yaml`), body);
	}
	if (config) fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), config);
	const file = path.join(dir, 'junction.yaml');
	fs.writeFileSync(file, `pattern: Junction\nbetween: [${between.join(', ')}]\n`);
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		return (await promptModule.prompt({ args: { yaml: file } })) as Record<string, any>;
	} finally {
		process.chdir(cwd);
	}
}

const ENTITIES = {
	crew: 'entity:\n  name: crew\n  plural: crews\n  context: org\n',
	person: 'entity:\n  name: person\n  plural: persons\n',
};

describe('junction endpoints resolve from their own YAML', () => {
	it('parent tables are the declared plurals', async () => {
		const l = await junctionLocals(['crew', 'person'], ENTITIES);
		expect(l.leftTable).toBe('crews');
		expect(l.rightTable).toBe('persons');
		expect(l.rightModuleClass).toBe('PersonsModule');
	});

	it('imports reach each endpoint at its own folder, both directions', async () => {
		const l = await junctionLocals(['crew', 'person'], ENTITIES);
		// junction (flat, src/modules/crew_people) → endpoints
		expect(l.leftEntityImportFromJunction).toBe('../org/crews/crew.entity');
		expect(l.rightEntityImportFromJunction).toBe('../persons/person.entity');
		expect(l.leftRepoImportFromJunction).toBe('../org/crews/crew.repository');
		expect(l.rightModuleImportFromJunction).toBe('../persons/persons.module');
		// endpoints → junction
		expect(l.junctionServiceImportFromLeft).toBe('../../crew_people/crew_person.service');
		expect(l.junctionEntityImportFromLeft).toBe('../../crew_people/crew_person.entity');
		expect(l.junctionModuleImportFromRight).toBe('../crew_people/crew_people.module');
		// parent → counterparty (the fan-out methods return its type)
		expect(l.rightEntityImportFromLeft).toBe('../../persons/person.entity');
		expect(l.leftEntityImportFromRight).toBe('../org/crews/crew.entity');
	});

	it('the parent inject targets are the endpoints’ own service/module files', async () => {
		const l = await junctionLocals(['crew', 'person'], ENTITIES);
		expect(l.parentServicePathLeft).toBe('src/modules/org/crews/crew.service.ts');
		expect(l.parentModulePathLeft).toBe('src/modules/org/crews/crews.module.ts');
		expect(l.parentServicePathRight).toBe('src/modules/persons/person.service.ts');
		expect(l.parentModulePathRight).toBe('src/modules/persons/persons.module.ts');
	});

	it('renders the resolved names into the junction entity and the parent inject', async () => {
		const l = await junctionLocals(['crew', 'person'], ENTITIES);
		const entity = render('entity.ejs.t', l);
		expect(entity).toContain("import { crews } from '../org/crews/crew.entity';");
		expect(entity).toContain("import { persons } from '../persons/person.entity';");
		expect(entity).toContain('.references(() => persons.id');
		expect(entity).not.toContain('people/person');
		expect(render('_inject-parent-service-import-clp-left.ejs.t', l)).toContain(
			"import type { CrewPerson } from '../../crew_people/crew_person.entity';",
		);
	});

	it('flat regular endpoints keep the sibling form (byte-identical to before)', async () => {
		const l = await junctionLocals(['opportunity', 'contact'], {
			opportunity: 'entity:\n  name: opportunity\n  plural: opportunities\n',
			contact: 'entity:\n  name: contact\n  plural: contacts\n',
		});
		expect(l.leftEntityImportFromJunction).toBe('../opportunities/opportunity.entity');
		expect(l.junctionServiceImportFromRight).toBe('../opportunity_contacts/opportunity_contact.service');
		expect(l.parentServicePathLeft).toBe('src/modules/opportunities/opportunity.service.ts');
	});

	it("architecture: clean keeps its fixed layout but uses the declared plural", async () => {
		const l = await junctionLocals(
			['crew', 'person'],
			ENTITIES,
			'generate:\n  architecture: clean\npaths:\n  backend_src: app/src\n',
		);
		expect(l.rightTable).toBe('persons');
		expect(l.leftEntityImportFromJunction).toBe('../crews/crew.entity');
		expect(l.parentServicePathRight).toBe('app/src/application/persons/person.service.ts');
	});

	it('an endpoint with no entity YAML is a named error, not a guess', async () => {
		await expect(junctionLocals(['crew', 'ghost'], ENTITIES)).rejects.toThrow(
			"endpoint 'ghost' has no entity YAML in the entities directory",
		);
	});
});
