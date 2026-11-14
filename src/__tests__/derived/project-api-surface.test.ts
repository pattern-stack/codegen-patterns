/**
 * The whole-set pass (ADR-046, PLAN §4.3): pairing, `inverseOf`, `generates`, `includeKeys`, `http.includes`,
 * `unmodelled` — and that the per-entity half is exactly `deriveEntityApiSurface`, so the CLI shows what hygen
 * emits.
 */

import { describe, expect, it } from 'bun:test';

import { resolvePatternComposition } from '../../../templates/entity/new/backend/entity-locals.js';
import type { EntityDefinitionInput, JunctionInput } from '../../derived/api/entity';
import { patternComposition } from '../../derived/api/project';
import type { EntityApiSurface, ProjectApiSurface } from '../../derived/api/types';
import { baselineSet, deriveSet } from './_inputs';
import { deriveBaselineProject, deriveProjectFromSet } from './_project';
import { RENDER_MATRIX } from './_render-matrix';

const def = (d: Record<string, unknown>): EntityDefinitionInput => d as unknown as EntityDefinitionInput;
const junction = (j: Record<string, unknown>): JunctionInput => j as unknown as JunctionInput;

/** The per-entity surface, without what only the whole-set pass attaches. */
function perEntity(s: EntityApiSurface): EntityApiSurface {
	const { includes: _includes, ...http } = s.http;
	return { ...s, http };
}

const relation = (p: ProjectApiSurface, id: string) => {
	const r = p.relations.find((x) => x.id === id);
	if (!r) throw new Error(`no relation ${id} in ${p.relations.map((x) => x.id).join(', ')}`);
	return r;
};

describe('project surface — the per-entity half is deriveEntityApiSurface', () => {
	it('the baseline set: every entity equals the per-entity derivation', () => {
		const project = deriveBaselineProject();
		const direct = deriveSet(baselineSet());
		expect(Object.keys(project.entities).sort()).toEqual([...direct.keys()].sort());
		for (const [name, surface] of direct) expect(perEntity(project.entities[name] as EntityApiSurface)).toEqual(surface);
	});

	it('every matrix case: every entity equals the per-entity derivation', () => {
		for (const c of RENDER_MATRIX) {
			const project = deriveProjectFromSet(c);
			for (const [name, surface] of deriveSet(c)) {
				expect(perEntity(project.entities[name] as EntityApiSurface)).toEqual(surface);
			}
		}
	});

	it("the pattern composition equals entity-locals.js's resolvePatternComposition for every fixture entity", () => {
		const blocks = [...baselineSet().entities, ...RENDER_MATRIX.flatMap((c) => c.entities)].map((d) => d.entity);
		for (const block of blocks) {
			const hygen = resolvePatternComposition(block);
			expect(patternComposition(block)).toEqual({
				patternName: hygen.patternName,
				repositoryBaseClass: hygen.repositoryBaseClass,
				serviceBaseClass: hygen.serviceBaseClass,
				repositoryInheritedMethods: hygen.repositoryInheritedMethods,
				serviceInheritedMethods: hygen.serviceInheritedMethods,
				capabilities: hygen.capabilities,
			});
		}
	});
});

describe('project surface — warnings', () => {
	it('the baseline set and every matrix case derive with no warning', () => {
		expect(deriveBaselineProject().warnings).toEqual([]);
		for (const c of RENDER_MATRIX) expect({ case: c.id, warnings: deriveProjectFromSet(c).warnings }).toEqual({ case: c.id, warnings: [] });
	});
});

describe('project surface — relations', () => {
	const account = def({
		entity: { name: 'account', plural: 'accounts' },
		fields: { name: { type: 'string', required: true } },
		relationships: {
			contacts: { type: 'has_many', target: 'contact', foreign_key: 'account_id' },
			primary_contact: { type: 'has_one', target: 'contact', foreign_key: 'primary_of_id', inverse: 'primary_of' },
		},
	});
	const contact = def({
		entity: { name: 'contact', plural: 'contacts' },
		fields: { email: { type: 'string', required: true } },
		relationships: {
			account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
			primary_of: { type: 'belongs_to', target: 'account', foreign_key: 'primary_of_id' },
			owner: { type: 'belongs_to', target: 'user', foreign_key: 'owner_id' },
		},
	});
	const user = def({ entity: { name: 'user', plural: 'users' }, fields: { email: { type: 'string', required: true } } });
	const project = deriveProjectFromSet({ entities: [account, contact, user], junctions: [] });

	it('pairs belongs_to ↔ has_many on the foreign key, both ways', () => {
		expect(relation(project, 'contact.relationships.account').inverseOf).toBe('account.relationships.contacts');
		expect(relation(project, 'account.relationships.contacts').inverseOf).toBe('contact.relationships.account');
	});

	it('pairs an explicit `inverse:`, both ways', () => {
		expect(relation(project, 'account.relationships.primary_contact').inverseOf).toBe('contact.relationships.primary_of');
		expect(relation(project, 'contact.relationships.primary_of').inverseOf).toBe('account.relationships.primary_contact');
	});

	it('leaves a declaration with no counterpart unpaired', () => {
		expect(relation(project, 'contact.relationships.owner').inverseOf).toBeUndefined();
	});

	it('indexes generates from origins — the winning method on each layer, never the inverse side', () => {
		expect(relation(project, 'contact.relationships.account').generates).toEqual([
			{ entity: 'contact', layer: 'repository', method: 'findByAccountId' },
			{ entity: 'contact', layer: 'service', method: 'account' },
		]);
		expect(relation(project, 'account.relationships.contacts').generates).toEqual([
			{ entity: 'account', layer: 'service', method: 'contacts' },
		]);
	});

	it("carries REL-1's own manifest keys", () => {
		expect(relation(project, 'contact.relationships.account')).toMatchObject({
			from: 'contact',
			to: 'account',
			kind: 'belongs_to',
			includeKeys: [{ table: 'contacts', key: 'account' }],
		});
		expect(relation(project, 'account.relationships.primary_contact')).toMatchObject({
			kind: 'has_one',
			includeKeys: [{ table: 'accounts', key: 'primaryContact' }],
		});
	});

	it("a role is a relation of kind role, with the role-derived belongs_to's methods and no manifest key", () => {
		const roles = RENDER_MATRIX.find((c) => c.id === 'matrix-role');
		if (!roles) throw new Error('matrix-role case missing');
		expect(relation(deriveProjectFromSet(roles), 'call.roles.caller')).toEqual({
			id: 'call.roles.caller',
			from: 'call',
			to: 'contact',
			kind: 'role',
			generates: [
				{ entity: 'call', layer: 'repository', method: 'findByCallerId' },
				{ entity: 'call', layer: 'service', method: 'caller' },
			],
			includeKeys: [],
		});
	});
});

describe('project surface — junctions and relationship definitions', () => {
	const member = def({ entity: { name: 'member', plural: 'members' }, fields: { name: { type: 'string', required: true } } });
	const skill = def({ entity: { name: 'skill', plural: 'skills' }, fields: { name: { type: 'string', required: true } } });
	const project = deriveProjectFromSet({
		entities: [member, skill],
		junctions: [junction({ pattern: 'Junction', between: ['member', 'skill'] })],
		relationships: [{ relationship: { name: 'member_endorsement', from: 'member', to: 'skill' } }],
	});

	it('lists the junction and the relationship definition as unmodelled, naming #679', () => {
		expect(project.unmodelled.map((u) => ({ name: u.name, kind: u.kind }))).toEqual([
			{ name: 'member_endorsement', kind: 'relationship' },
			{ name: 'member_skill', kind: 'junction' },
		]);
		for (const u of project.unmodelled) expect(u.reason).toContain('#679');
	});

	it("a junction is a relation of kind junction: REL-1's six keys, the fan-out on both parents", () => {
		const r = relation(project, 'junction member_skill');
		expect(r).toMatchObject({ from: 'member', to: 'skill', kind: 'junction' });
		expect(r.includeKeys).toHaveLength(6);
		expect(r.generates.map((g) => `${g.entity}.${g.method}`)).toEqual([
			'member.attachSkill',
			'member.detachSkill',
			'member.skillsList',
			'member.skillsSetPrimary',
			'skill.addToMember',
			'skill.removeFromMember',
			'skill.membersList',
			'skill.membersSetPrimary',
		]);
	});
});

describe('project surface — http.includes', () => {
	it("attaches REL-2's compiled allowlist to the entity that declares it, and nothing to one that does not", () => {
		const c = RENDER_MATRIX.find((x) => x.id === 'matrix-api-includes');
		if (!c) throw new Error('matrix-api-includes case missing');
		const project = deriveProjectFromSet(c);
		expect(project.entities.project?.http.includes).toEqual([
			{ route: 'find_by_id', maxDepth: 1, paths: [{ path: 'account', depth: 1 }, { path: 'tasks', depth: 1 }] },
			{ route: 'list', maxDepth: 1, paths: [{ path: 'account', depth: 1 }] },
		]);
		expect(project.entities.task?.http.includes).toBeUndefined();
	});
});
