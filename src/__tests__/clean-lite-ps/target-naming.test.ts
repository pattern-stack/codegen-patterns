/**
 * NAME-0 (#630) — a clean-lite-ps entity names every OTHER entity it references
 * from that entity's own YAML (`plural:`, `context:`), never by re-pluralizing
 * the target's name at emit time.
 *
 * The two shapes a re-derivation gets wrong:
 *   - `person` declares `plural: persons`; `pluralize('person')` is `people`.
 *   - `crew` declares `context: org`, so its folder is `modules/org/crews/`,
 *     not a flat sibling.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ejs from 'ejs';
import { buildCleanLitePsLocals } from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';
import { entityLookupFrom } from '../../../templates/_shared/entity-naming.mjs';

const TEMPLATES = path.resolve(import.meta.dir, '../../../templates/entity/new/clean-lite-ps');

function render(template: string, locals: Record<string, unknown>): string {
	const source = fs.readFileSync(path.join(TEMPLATES, template), 'utf8');
	const body = source.replace(/^---\n[\s\S]*?\n---\n/, '');
	return ejs.render(body, locals, { rmWhitespace: false });
}

const PERSON = { name: 'person', plural: 'persons' };
const CREW = { name: 'crew', plural: 'crews', context: 'org' };
const CRITERION = { name: 'criterion', plural: 'criterions', context: 'meta' };
const lookup = entityLookupFrom([PERSON, CREW, CRITERION]);

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

type Locals = Record<string, any>;
function localsFor(
	entity: Record<string, unknown>,
	extra: Record<string, unknown> = {},
	base: Record<string, unknown> = {},
): Locals {
	return buildCleanLitePsLocals(
		{
			entity: { table: entity.plural, ...entity },
			fields: { name: { type: 'string', required: true } },
			relationships: {},
			behaviors: ['timestamps'],
			...extra,
		},
		{ srcRoot: 'src', entityLookup: lookup, ...base },
	) as Locals;
}

// A flat entity with an FK to each shape.
const badge = () =>
	localsFor(
		{ name: 'badge', plural: 'badges' },
		{
			relationships: {
				holder: { type: 'belongs_to', target: 'person', foreign_key: 'holder_person_id' },
				crew: { type: 'belongs_to', target: 'crew', foreign_key: 'crew_id' },
			},
		},
	);

describe('belongs_to', () => {
	it("takes the table export from the target's declared plural", () => {
		const holder = badge().clpBelongsTo.find((r: Locals) => r.relatedEntity === 'person');
		expect(holder.relatedTable).toBe('persons');
		expect(holder.importPath).toBe('../persons/person.entity');
	});

	it("addresses a context:-nested target at its own folder", () => {
		const crew = badge().clpBelongsTo.find((r: Locals) => r.relatedEntity === 'crew');
		expect(crew.relatedTable).toBe('crews');
		expect(crew.importPath).toBe('../org/crews/crew.entity');
	});

	it('from a nested entity, climbs out of its context to a flat target', () => {
		const locals = localsFor(
			CREW,
			{ relationships: { lead: { type: 'belongs_to', target: 'person', foreign_key: 'lead_person_id' } } },
		);
		expect(locals.clpBelongsTo[0].importPath).toBe('../../persons/person.entity');
	});

	it('renders the resolved names into entity, service and module', () => {
		const locals = badge();
		const entity = render('entity.ejs.t', locals);
		expect(entity).toContain("import { persons } from '../persons/person.entity';");
		expect(entity).toContain("import { crews } from '../org/crews/crew.entity';");
		expect(entity).toContain('.references((): AnyPgColumn => persons.id');
		expect(entity).toContain('.references((): AnyPgColumn => crews.id');
		expect(entity).not.toContain('people');

		const service = render('service.ejs.t', locals);
		expect(service).toContain("import { PersonRepository } from '../persons/person.repository';");
		expect(service).toContain("import type { Crew } from '../org/crews/crew.entity';");

		const module = render('module.ejs.t', locals);
		expect(module).toContain("import { CrewRepository } from '../org/crews/crew.repository';");
	});

	it('a target with no entity YAML is a generation error naming it', () => {
		expect(() =>
			localsFor(
				{ name: 'badge', plural: 'badges' },
				{ relationships: { owner: { type: 'belongs_to', target: 'ghost', foreign_key: 'ghost_id' } } },
			),
		).toThrow("'badge' references 'ghost', which has no entity YAML — no YAML under <in-memory> declares");
	});

	it('a self-reference needs no lookup', () => {
		const locals = localsFor(
			{ name: 'badge', plural: 'badges' },
			{ relationships: { parent: { type: 'belongs_to', target: 'badge', foreign_key: 'parent_badge_id' } } },
			{ entityLookup: entityLookupFrom([]) },
		);
		expect(locals.clpBelongsTo[0]).toMatchObject({ isSelfFk: true, relatedTable: 'badges' });
	});
});

describe('has_many', () => {
	const roster = (srcRoot: string, relationships: Record<string, unknown>) =>
		localsFor(CREW, { relationships }, { srcRoot });

	it("resolves the target's import folder and checks it on disk at that folder", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'name0-'));
		tmpDirs.push(root);
		const rels = { members: { type: 'has_many', target: 'person', foreign_key: 'crew_id' } };

		const before = roster(root, rels).clpHasMany[0];
		expect(before.targetPlural).toBe('persons');
		expect(before.targetImportDir).toBe('../../persons');
		expect(before.targetExists).toBe(false);

		// The re-derived folder does not count…
		fs.mkdirSync(path.join(root, 'modules', 'people'), { recursive: true });
		fs.writeFileSync(path.join(root, 'modules', 'people', 'person.entity.ts'), '');
		expect(roster(root, rels).clpHasMany[0].targetExists).toBe(false);

		// …the target's own folder does.
		fs.mkdirSync(path.join(root, 'modules', 'persons'), { recursive: true });
		fs.writeFileSync(path.join(root, 'modules', 'persons', 'person.entity.ts'), '');
		const after = roster(root, rels);
		expect(after.clpHasMany[0].targetExists).toBe(true);
		expect(render('module.ejs.t', after)).toContain(
			"import { PersonRepository } from '../../persons/person.repository';",
		);
	});

	it('a target with no entity YAML stays a soft skip (not wired, no error)', () => {
		const rels = { ghosts: { type: 'has_many', target: 'ghost', foreign_key: 'crew_id' } };
		const [ghosts] = roster('src', rels).clpHasMany;
		expect(ghosts).toMatchObject({ targetExists: false, targetPlural: null, importPath: null });
	});
});

describe('field-level foreign_key: <table>.<column>', () => {
	it('imports from the entity whose YAML declares that table — not singularize(table)', () => {
		const locals = localsFor(
			{ name: 'badge', plural: 'badges' },
			{ fields: { holder_id: { type: 'uuid', foreign_key: 'persons.id' } } },
		);
		expect(locals.clpFieldFkImports).toEqual([
			{ relatedTable: 'persons', importPath: '../persons/person.entity' },
		]);
	});

	it('a table no entity YAML declares is a generation error', () => {
		expect(() =>
			localsFor(
				{ name: 'badge', plural: 'badges' },
				{ fields: { holder_id: { type: 'uuid', foreign_key: 'people.id' } } },
			),
		).toThrow(
			"the table 'people' is not owned by any entity YAML (no YAML under <in-memory> declares `plural: people`). " +
				'Either declare that entity (a YAML with `plural: people`), or drop the column-level `foreign_key:`',
		);
	});
});

describe('eav_definition_table', () => {
	it("names the definition module from the definition entity's YAML", () => {
		const locals = localsFor(
			{ name: 'criterion_value', plural: 'criterion_values', pattern: 'Metadata' },
			{
				eav_value_table: true,
				eav_definition_table: 'criterion',
				fields: {
					entity_type: { type: 'string', required: true },
					entity_id: { type: 'uuid', required: true },
					criterion_id: { type: 'uuid', required: true },
					user_id: { type: 'uuid', required: true },
					value: { type: 'json', required: true },
				},
			},
		);
		expect(locals.eavDefinitionEntityPlural).toBe('criterions');
		expect(locals.eavDefinitionImportDir).toBe('../meta/criterions');
		expect(render('module.ejs.t', locals)).toContain(
			"import { CriterionsModule } from '../meta/criterions/criterions.module';",
		);
		expect(render('service.ejs.t', locals)).toContain(
			"import { CriterionRepository } from '../meta/criterions/criterion.repository';",
		);
	});
});

describe('a service that composes the same target twice (#632)', () => {
	// `person` both belongs_to `crew` and has_many `crew`: one repository, one
	// import, one constructor parameter — whichever edges reach it.
	const both = () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'name1-'));
		tmpDirs.push(root);
		fs.mkdirSync(path.join(root, 'modules', 'org', 'crews'), { recursive: true });
		fs.writeFileSync(path.join(root, 'modules', 'org', 'crews', 'crew.entity.ts'), '');
		return localsFor(
			PERSON,
			{
				relationships: {
					crew: { type: 'belongs_to', target: 'crew', foreign_key: 'crew_id' },
					led_crews: { type: 'has_many', target: 'crew', foreign_key: 'lead_person_id' },
				},
			},
			{ srcRoot: root },
		);
	};

	it('collects one repository dependency per target entity', () => {
		expect(both().clpRepositoryDeps).toEqual([
			{
				entity: 'crew',
				entityClass: 'Crew',
				repositoryClass: 'CrewRepository',
				property: 'crewRepo',
				importDir: '../org/crews',
			},
		]);
	});

	it('the service imports and injects it once; both methods use it', () => {
		const service = render('service.ejs.t', both());
		const count = (needle: string) => service.split(needle).length - 1;
		expect(count("import { CrewRepository } from '../org/crews/crew.repository';")).toBe(1);
		expect(count("import type { Crew } from '../org/crews/crew.entity';")).toBe(1);
		expect(count('private readonly crewRepo: CrewRepository,')).toBe(1);
		// Per-relationship methods are unchanged: one per edge.
		expect(service).toContain('this.crewRepo.findById(entity.crewId)');
		expect(service).toContain('this.crewRepo.findByLeadPersonId(personId, opts)');
	});

	it('the module imports and provides it once', () => {
		const module = render('module.ejs.t', both());
		const count = (needle: string) => module.split(needle).length - 1;
		expect(count("import { CrewRepository } from '../org/crews/crew.repository';")).toBe(1);
		expect(count('    CrewRepository,\n')).toBe(1);
	});

	it('an EAV definition entity also reached by a belongs_to is imported and injected once', () => {
		const locals = localsFor(
			{ name: 'criterion_value', plural: 'criterion_values', pattern: 'Metadata' },
			{
				eav_value_table: true,
				eav_definition_table: 'criterion',
				fields: {
					entity_type: { type: 'string', required: true },
					entity_id: { type: 'uuid', required: true },
					user_id: { type: 'uuid', required: true },
					value: { type: 'json', required: true },
				},
				relationships: {
					criterion: { type: 'belongs_to', target: 'criterion', foreign_key: 'criterion_id' },
				},
			},
		);
		expect(locals.eavDefinitionRepositoryImported).toBe(true);
		const service = render('service.ejs.t', locals);
		expect(
			service.split("import { CriterionRepository } from '../meta/criterions/criterion.repository';").length - 1,
		).toBe(1);
		// One constructor parameter for the class; the EAV methods address it.
		expect(service.split(': CriterionRepository,').length - 1).toBe(1);
		expect(service).toContain('private readonly criterionRepo: CriterionRepository,');
		expect(service).not.toContain('definitionRepo');
		expect(service).toContain('this.criterionRepo.list()');
	});
});

describe('every FK callback is annotated (#631)', () => {
	it('a cross-entity belongs_to FK carries AnyPgColumn, and the type is imported', () => {
		const entity = render('entity.ejs.t', badge());
		expect(entity).toContain('type AnyPgColumn,');
		expect(entity).not.toContain('.references(() =>');
	});

	it('a cross-entity field-level foreign_key carries AnyPgColumn', () => {
		const locals = localsFor(
			{ name: 'badge', plural: 'badges' },
			{ fields: { holder_id: { type: 'uuid', foreign_key: 'persons.id' } } },
		);
		expect(locals.clpHasFk).toBe(true);
		const entity = render('entity.ejs.t', locals);
		expect(entity).toContain("holderId: uuid('holder_id').references((): AnyPgColumn => persons.id),");
		expect(entity).toContain('type AnyPgColumn,');
	});

	it('a table with no FK column does not import AnyPgColumn', () => {
		const locals = localsFor({ name: 'badge', plural: 'badges' });
		expect(locals.clpHasFk).toBe(false);
		expect(render('entity.ejs.t', locals)).not.toContain('AnyPgColumn');
	});
});
