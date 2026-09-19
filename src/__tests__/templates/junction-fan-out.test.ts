/**
 * JUNC-0 (#678) — a junction's fan-out onto its two parents is rendered by the
 * parents' OWN clean-lite-ps service + module templates, from the junction YAML
 * set (`templates/_shared/junction-fan-out.mjs`). Nothing injects into them, so
 * the parent files are a function of the YAMLs, not of which command ran last.
 *
 * The endpoint shapes a re-derivation gets wrong (NAME-0): `crew` is
 * `context: org` (folder `modules/org/crews/`), `person` declares
 * `plural: persons` (`pluralize('person')` is `people`).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ejs from 'ejs';
import {
	junctionFanOutFor,
	junctionName,
	junctionNaming,
	loadJunctionDefinitions,
} from '../../../templates/_shared/junction-fan-out.mjs';
import { entityLookupFrom } from '../../../templates/_shared/entity-naming.mjs';
import { buildCleanLitePsLocals } from '../../../templates/entity/new/clean-lite-ps/prompt-extension.js';
import { deriveJunctionName } from '../../schema/junction-definition.schema';
import { withEntities } from '../clean-lite-ps/_entity-lookup';

const TEMPLATES = path.resolve(import.meta.dir, '../../../templates/entity/new/clean-lite-ps');

function render(template: string, locals: Record<string, unknown>): string {
	const source = fs.readFileSync(path.join(TEMPLATES, template), 'utf8');
	const body = source.replace(/^---\n[\s\S]*?\n---\n/, '');
	return ejs.render(body, locals, { rmWhitespace: false });
}

const CREW = { name: 'crew', plural: 'crews', context: 'org' };
const PERSON = { name: 'person', plural: 'persons' };
const ACCOUNT = { name: 'account', plural: 'accounts' };
const lookup = entityLookupFrom([CREW, PERSON, ACCOUNT]);
const MODULES = 'src/modules';

const fanOut = (entity: string, junctions: unknown[], selfModuleDir: string) =>
	junctionFanOutFor(entity, { junctions, modulesDir: MODULES, entityLookup: lookup, selfModuleDir });

const CREW_PERSON = { pattern: 'Junction', between: ['crew', 'person'] };

describe('junctionNaming — the one junction naming rule', () => {
	it('agrees with the CLI-side deriveJunctionName', () => {
		for (const between of [
			['opportunity', 'contact'],
			['crew', 'person'],
			['account_team', 'user'],
		] as Array<[string, string]>) {
			expect(junctionName(between)).toBe(deriveJunctionName({ between }));
		}
	});

	it('names the table, the flat folder, the files and the classes', () => {
		expect(junctionNaming('crew_person', MODULES)).toEqual({
			name: 'crew_person',
			plural: 'crew_people',
			moduleDir: 'src/modules/crew_people',
			entityFile: 'src/modules/crew_people/crew_person.entity',
			repositoryFile: 'src/modules/crew_people/crew_person.repository.ts',
			serviceFile: 'src/modules/crew_people/crew_person.service.ts',
			moduleFile: 'src/modules/crew_people/crew_people.module.ts',
			tableVar: 'crewPeople',
			entityClass: 'CrewPerson',
			serviceClass: 'CrewPersonService',
			moduleClass: 'CrewPeopleModule',
			linkInputType: 'CrewPersonLinkInput',
			serviceProperty: 'crewPersonService',
		});
	});
});

describe('junctionFanOutFor', () => {
	it('mirrors a junction onto both endpoints, with the side’s method vocabulary', () => {
		const [left] = fanOut('crew', [CREW_PERSON], 'src/modules/org/crews');
		expect(left).toMatchObject({
			side: 'left',
			attachMethod: 'attachPerson',
			detachMethod: 'detachPerson',
			listMethod: 'personsList',
			setPrimaryMethod: 'personsSetPrimary',
			selfIdParam: 'crewId',
			counterpartyIdParam: 'personId',
			leftIdParam: 'crewId',
			rightIdParam: 'personId',
		});
		const [right] = fanOut('person', [CREW_PERSON], 'src/modules/persons');
		expect(right).toMatchObject({
			side: 'right',
			attachMethod: 'addToCrew',
			detachMethod: 'removeFromCrew',
			listMethod: 'crewsList',
			setPrimaryMethod: 'crewsSetPrimary',
			selfIdParam: 'personId',
			counterpartyIdParam: 'crewId',
		});
	});

	it('imports reach the junction and the counterparty at their own folders', () => {
		const [left] = fanOut('crew', [CREW_PERSON], 'src/modules/org/crews');
		expect(left.junctionServiceImport).toBe('../../crew_people/crew_person.service');
		expect(left.junctionEntityImport).toBe('../../crew_people/crew_person.entity');
		expect(left.junctionModuleImport).toBe('../../crew_people/crew_people.module');
		expect(left.counterpartyEntityImport).toBe('../../persons/person.entity');
		const [right] = fanOut('person', [CREW_PERSON], 'src/modules/persons');
		expect(right.junctionModuleImport).toBe('../crew_people/crew_people.module');
		expect(right.counterpartyEntityImport).toBe('../org/crews/crew.entity');
	});

	it('honours expose_on_parent per side', () => {
		const j = { ...CREW_PERSON, expose_on_parent: { left: false } };
		expect(fanOut('crew', [j], 'src/modules/org/crews')).toEqual([]);
		expect(fanOut('person', [j], 'src/modules/persons')).toHaveLength(1);
	});

	it('is empty for an entity no junction names; ordered by junction name otherwise', () => {
		expect(fanOut('account', [CREW_PERSON], 'src/modules/accounts')).toEqual([]);
		const blocks = fanOut(
			'person',
			[CREW_PERSON, { pattern: 'Junction', between: ['account', 'person'] }].reverse(),
			'src/modules/persons',
		);
		// The caller (loadJunctionDefinitions) sorts; the helper keeps its input order.
		expect(blocks.map((b: { junction: { name: string } }) => b.junction.name)).toEqual([
			'account_person',
			'crew_person',
		]);
	});

	it('a counterparty with no entity YAML is a named error', () => {
		expect(() =>
			fanOut('crew', [{ pattern: 'Junction', between: ['crew', 'ghost'] }], 'src/modules/org/crews'),
		).toThrow(/junction 'crew_ghost': endpoint 'ghost' has no entity YAML/);
	});
});

describe('loadJunctionDefinitions', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});

	it('reads junction YAMLs only, sorted by junction name; no directory is an empty set', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-defs-'));
		dirs.push(dir);
		expect(loadJunctionDefinitions(dir)).toEqual([]);
		fs.mkdirSync(path.join(dir, 'junctions'));
		fs.writeFileSync(path.join(dir, 'junctions', 'z.yaml'), 'pattern: Junction\nbetween: [crew, person]\n');
		fs.writeFileSync(path.join(dir, 'junctions', 'a.yaml'), 'pattern: Junction\nbetween: [person, account]\n');
		fs.writeFileSync(path.join(dir, 'junctions', 'notes.yaml'), 'entity:\n  name: note\n');
		expect(loadJunctionDefinitions(dir).map((d: { between: string[] }) => junctionName(d.between))).toEqual([
			'crew_person',
			'person_account',
		]);
	});
});

describe('the parent templates render the fan-out', () => {
	type Locals = Record<string, any>;
	const localsFor = (
		entity: Record<string, unknown>,
		junctions: unknown[],
		relationships: Record<string, unknown> = {},
	): Locals =>
		buildCleanLitePsLocals(
			{
				entity: { table: entity.plural, ...entity },
				fields: { name: { type: 'string', required: true } },
				relationships,
				behaviors: ['timestamps'],
			},
			{ ...withEntities(), modulesDir: MODULES, entityLookup: lookup, junctions },
		) as Locals;

	it('no junction → no fan-out, no forwardRef', () => {
		const l = localsFor(ACCOUNT, [CREW_PERSON]);
		expect(l.clpJunctionFanOut).toEqual([]);
		expect(render('service.ejs.t', l)).not.toContain('forwardRef');
		expect(render('module.ejs.t', l)).not.toContain('forwardRef');
	});

	it('service: one @nestjs/common import, the junction imports, the four methods', () => {
		const svc = render('service.ejs.t', localsFor(CREW, [CREW_PERSON]));
		expect(svc).toContain("import { Injectable, Inject, Optional, forwardRef } from '@nestjs/common';");
		expect(svc.match(/from '@nestjs\/common'/g)).toHaveLength(1);
		expect(svc).toContain(
			"import { CrewPersonService, CrewPersonLinkInput } from '../../crew_people/crew_person.service';",
		);
		expect(svc).toContain("import type { CrewPerson } from '../../crew_people/crew_person.entity';");
		expect(svc).toContain("import type { Person } from '../../persons/person.entity';");
		expect(svc).toContain('@Inject(forwardRef(() => CrewPersonService))');
		expect(svc).toContain('private readonly crewPersonService!: CrewPersonService;');
		expect(svc).toContain('return this.crewPersonService.attach(crewId, personId, link);');
		expect(svc).toContain('return this.crewPersonService.detach(crewId, personId);');
		expect(svc).toContain("return this.crewPersonService.listAssoc('left', crewId, opts) as Promise<");
		expect(svc).toContain('): Promise<Array<{ entity: Person; link: CrewPerson }>> {');
		expect(svc).toContain('return this.crewPersonService.setPrimary(crewId, personId);');
		// The lifecycle comment block is no longer split by the fan-out.
		expect(svc).toMatch(/\/\/ Inherited from BaseService:\n(\s+\/\/ {3}.*\n)+/);
	});

	it('module: forwardRef joins the one import; the junction module is imported via forwardRef', () => {
		const mod = render('module.ejs.t', localsFor(PERSON, [CREW_PERSON]));
		expect(mod).toContain("import { Inject, Module, forwardRef, type OnModuleInit } from '@nestjs/common';");
		expect(mod).toContain("import { CrewPeopleModule } from '../crew_people/crew_people.module';");
		expect(mod).toContain('    DatabaseModule,\n    forwardRef(() => CrewPeopleModule),\n');
	});

	it('the counterparty type is imported once when a composed repository already imports it', () => {
		const badge = { name: 'badge', plural: 'badges' };
		const l = localsFor(badge, [{ pattern: 'Junction', between: ['badge', 'person'] }], {
			holder: { type: 'belongs_to', target: 'person', foreign_key: 'holder_person_id' },
		});
		expect(l.clpJunctionFanOut[0].importCounterparty).toBe(false);
		const svc = render('service.ejs.t', l);
		expect(svc.match(/import type \{ Person \} from '\.\.\/persons\/person\.entity';/g)).toHaveLength(1);
	});

	it('re-rendering is byte-identical (no inject state)', () => {
		const a = render('service.ejs.t', localsFor(CREW, [CREW_PERSON]));
		const b = render('service.ejs.t', localsFor(CREW, [CREW_PERSON]));
		expect(a).toBe(b);
	});
});
