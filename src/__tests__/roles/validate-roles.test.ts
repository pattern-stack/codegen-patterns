/**
 * CAP-2 — roles validation: the per-entity Communication rule and the
 * project-level target / junction rules.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ParsedEntity, ParsedRole } from '../../analyzer/types.ts';
import { loadEntities } from '../../parser/load-entities.ts';
import { loadJunctionSummaries } from '../../parser/load-junctions.ts';
import {
	_resetRegistryForTests,
	registerLibraryPattern,
} from '../../patterns/registry.ts';
import { validatePatternComposition } from '../../patterns/validate-composition.ts';
import { validateRolesProject } from '../../roles/validate-roles.ts';
import '../../patterns/index.ts';
import {
	ActivityPattern,
	BasePattern,
	IntegratedPattern,
	JunctionPattern,
	KnowledgePattern,
	MetadataPattern,
} from '../../patterns/library/index.ts';

// CAP-3 ships `Actor` / `Communication`. Until then a project declares its own;
// these stand in for that, exactly as an app capability would.
function registerCapabilityStubs(): void {
	registerLibraryPattern({
		name: 'Actor',
		kind: 'capability',
		forwarderMethods: ['memberPredicate'],
	});
	registerLibraryPattern({
		name: 'Communication',
		kind: 'capability',
		forwarderMethods: ['findByRole'],
	});
}

beforeEach(() => {
	_resetRegistryForTests({ includeLibrary: true });
	for (const p of [BasePattern, IntegratedPattern, ActivityPattern, KnowledgePattern, MetadataPattern, JunctionPattern]) {
		registerLibraryPattern(p);
	}
	registerCapabilityStubs();
});

afterAll(() => {
	_resetRegistryForTests({ includeLibrary: true });
	for (const p of [BasePattern, IntegratedPattern, ActivityPattern, KnowledgePattern, MetadataPattern, JunctionPattern]) {
		registerLibraryPattern(p);
	}
});

function entity(
	name: string,
	opts: { patterns?: string[]; roles?: ParsedRole[] } = {},
): ParsedEntity {
	return {
		name,
		plural: `${name}s`,
		table: `${name}s`,
		patterns: opts.patterns,
		expose: ['repository', 'rest', 'trpc'],
		folderStructure: 'nested',
		fields: new Map(),
		relationships: new Map(),
		roles: opts.roles ? new Map(opts.roles.map((r) => [r.name, r])) : undefined,
		behaviors: [],
		sourcePath: `/fake/${name}.yaml`,
	};
}

const host: ParsedRole = { name: 'host', target: 'contact', cardinality: 'one', foreignKey: 'host_contact_id' };
const attendees: ParsedRole = { name: 'attendees', target: 'contact', cardinality: 'many', via: 'meeting_contact' };

describe('per-entity — roles: and Communication imply each other', () => {
	test('roles: without Communication is an error, even with no patterns: at all', () => {
		const issues = validatePatternComposition(entity('meeting', { roles: [host] }));
		expect(issues.map((i) => i.type)).toContain('role_without_communication');
	});

	test('Communication without roles: is an error', () => {
		const issues = validatePatternComposition(entity('meeting', { patterns: ['Activity', 'Communication'] }));
		expect(issues.map((i) => i.type)).toContain('communication_without_roles');
	});

	test('both together validate clean', () => {
		const issues = validatePatternComposition(
			entity('meeting', { patterns: ['Activity', 'Communication'], roles: [host] }),
		);
		expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
	});
});

describe('project-level — targets', () => {
	const contactActor = entity('contact', { patterns: ['Actor'] });

	test('a target that declares Actor validates clean', () => {
		const issues = validateRolesProject({
			entities: [entity('meeting', { roles: [host] }), contactActor],
		});
		expect(issues).toEqual([]);
	});

	test('an unknown target is an error', () => {
		const issues = validateRolesProject({ entities: [entity('meeting', { roles: [host] })] });
		expect(issues.map((i) => i.type)).toEqual(['role_target_unknown']);
	});

	test('a target without Actor is an error that says what to add', () => {
		const issues = validateRolesProject({
			entities: [entity('meeting', { roles: [host] }), entity('contact')],
		});
		expect(issues).toHaveLength(1);
		expect(issues[0]?.type).toBe('role_target_not_actor');
		expect(issues[0]?.message).toContain("Add 'Actor' to contact's patterns:");
	});

	test('a DOMAIN pattern named Actor does not count — it must be a capability', () => {
		_resetRegistryForTests({ includeLibrary: true });
		registerLibraryPattern(BasePattern);
		registerLibraryPattern({ name: 'Actor', repositoryClass: 'ActorRepository' });
		const issues = validateRolesProject({
			entities: [entity('meeting', { roles: [host] }), entity('contact', { patterns: ['Actor'] })],
		});
		expect(issues.map((i) => i.type)).toEqual(['role_target_not_actor']);
	});
});

describe('project-level — many-roles and their junction', () => {
	const entities = [
		entity('meeting', { roles: [attendees] }),
		entity('contact', { patterns: ['Actor'] }),
	];

	test('via: must be a name the pairing can produce', () => {
		const bad = { ...attendees, via: 'meeting_attendees' };
		const issues = validateRolesProject({
			entities: [entity('meeting', { roles: [bad] }), entity('contact', { patterns: ['Actor'] })],
		});
		expect(issues.map((i) => i.type)).toEqual(['role_via_mismatch']);
		expect(issues[0]?.message).toContain('meeting_contact, contact_meeting');
	});

	test('either declaration order of the pairing is accepted', () => {
		const flipped = { ...attendees, via: 'contact_meeting' };
		const issues = validateRolesProject({
			entities: [entity('meeting', { roles: [flipped] }), entity('contact', { patterns: ['Actor'] })],
		});
		expect(issues).toEqual([]);
	});

	test('without a junction list, the naming rule alone applies', () => {
		expect(validateRolesProject({ entities })).toEqual([]);
	});

	test('with a junction list, the named junction must exist', () => {
		const issues = validateRolesProject({ entities, junctions: [] });
		expect(issues.map((i) => i.type)).toEqual(['role_via_unknown']);
	});

	test('with a junction list, an existing junction between the pair validates clean', () => {
		const issues = validateRolesProject({
			entities,
			junctions: [{ name: 'meeting_contact', between: ['meeting', 'contact'] }],
		});
		expect(issues).toEqual([]);
	});
});

describe('parser — roles reach ParsedEntity', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap2-parse-'));
	});

	test('one-roles merge into relationships under the role key; many-roles do not', () => {
		fs.writeFileSync(
			path.join(dir, 'meeting.yaml'),
			[
				'entity: { name: meeting, plural: meetings, table: meetings }',
				'fields: { title: { type: string, required: true } }',
				'roles:',
				'  host: { target: contact, cardinality: one }',
				'  attendees: { target: contact, cardinality: many, via: meeting_contact }',
			].join('\n'),
		);
		const { entities, issues } = loadEntities(dir);
		expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
		const meeting = entities[0]!;

		expect([...(meeting.roles?.keys() ?? [])].sort()).toEqual(['attendees', 'host']);
		expect(meeting.roles?.get('host')?.foreignKey).toBe('host_contact_id');
		expect(meeting.roles?.get('attendees')?.foreignKey).toBeUndefined();

		const rel = meeting.relationships.get('host');
		expect(rel).toMatchObject({
			type: 'belongs_to',
			target: 'contact',
			foreignKey: 'host_contact_id',
			role: 'host',
		});
		expect(meeting.relationships.has('attendees')).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('junction discovery reduces each junction YAML to its name and pairing', () => {
		fs.writeFileSync(
			path.join(dir, 'meeting_contact.yaml'),
			'pattern: Junction\nbetween: [meeting, contact]\n',
		);
		expect(loadJunctionSummaries(dir)).toEqual([
			{ name: 'meeting_contact', between: ['meeting', 'contact'] },
		]);
		expect(loadJunctionSummaries(path.join(dir, 'does-not-exist'))).toEqual([]);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
