/**
 * NAME-2 (#695 / #684) — the emitted-file naming rule.
 *
 *   The filesystem is kebab-case. The database is snake_case.
 *
 * The load-bearing test here is the PROPERTY one: for a multi-word entity, no
 * segment of any emitted path may contain `_`. Listing today's filenames would
 * pass just as well and would say nothing about the stem someone adds by hand
 * next month — which is exactly how #684 happened (the hyphens in
 * `find-<entity>-by-id.use-case.ts` were typed characters in ~18 template
 * literals, so single-word entities were kebab by accident).
 */

import { describe, expect, it } from 'bun:test';
import { emittedDir, emittedStem, kebab } from '../../config/file-naming.js';
import { entityModuleNaming } from '../../config/module-tree.js';

const MODULES_DIR = 'src/modules';

/** A multi-word entity — the only shape that can expose the defect. */
const DEAL_STATE = { name: 'deal_state', plural: 'deal_states' };

describe('kebab — the one primitive', () => {
	it('normalizes every input case', () => {
		expect(kebab('deal_state')).toBe('deal-state');
		expect(kebab('deal-state')).toBe('deal-state');
		expect(kebab('dealState')).toBe('deal-state');
		expect(kebab('DealState')).toBe('deal-state');
	});

	it('is identity for a single lowercase word — why the defect stayed invisible', () => {
		for (const word of ['contact', 'account', 'opportunity', 'person']) {
			expect(kebab(word)).toBe(word);
		}
	});

	it('is idempotent', () => {
		expect(kebab(kebab('deal_state'))).toBe('deal-state');
	});

	it('handles empty and single-character input', () => {
		expect(kebab('')).toBe('');
		expect(kebab('a')).toBe('a');
	});
});

describe('emittedStem — a stem from its parts', () => {
	it('joins segments, kebab-casing each', () => {
		expect(emittedStem('find', 'deal_state', 'by-id')).toBe('find-deal-state-by-id');
		expect(emittedStem('list', 'deal_states')).toBe('list-deal-states');
		expect(emittedStem('deal_state', 'output')).toBe('deal-state-output');
		expect(emittedStem('deal_state')).toBe('deal-state');
	});

	it('drops empty segments rather than emitting a double hyphen', () => {
		expect(emittedStem('find', '', 'by-id')).toBe('find-by-id');
	});
});

describe('emittedDir', () => {
	it('kebab-cases a directory segment', () => {
		expect(emittedDir('deal_states')).toBe('deal-states');
	});
});

describe('entityModuleNaming applies the rule', () => {
	it('kebab-cases the module directory and every named file', () => {
		const naming = entityModuleNaming(DEAL_STATE, MODULES_DIR);
		expect(naming.moduleDir).toBe('src/modules/deal-states');
		expect(naming.entityFile).toBe('src/modules/deal-states/deal-state.entity');
		expect(naming.moduleFile).toBe('src/modules/deal-states/deal-states.module.ts');
		expect(naming.repositoryFile).toBe('src/modules/deal-states/deal-state.repository.ts');
	});

	it('kebab-cases a `context:` segment too', () => {
		const naming = entityModuleNaming({ ...DEAL_STATE, context: 'sales_ops' }, MODULES_DIR);
		expect(naming.moduleDir).toBe('src/modules/sales-ops/deal-states');
	});

	it('leaves `plural` snake_case — it is the SQL table name, not a path', () => {
		const naming = entityModuleNaming(DEAL_STATE, MODULES_DIR);
		expect(naming.plural).toBe('deal_states');
	});

	it('is byte-identical for a single-word entity', () => {
		const naming = entityModuleNaming({ name: 'contact', plural: 'contacts' }, MODULES_DIR);
		expect(naming.moduleDir).toBe('src/modules/contacts');
		expect(naming.entityFile).toBe('src/modules/contacts/contact.entity');
		expect(naming.moduleFile).toBe('src/modules/contacts/contacts.module.ts');
		expect(naming.repositoryFile).toBe('src/modules/contacts/contact.repository.ts');
	});
});

describe('the property: no emitted path segment carries an underscore', () => {
	/** Every path segment below `modulesDir`, for a path the generator emits. */
	const segmentsOf = (p: string): string[] => p.slice(MODULES_DIR.length + 1).split('/');

	const assertNoUnderscore = (paths: Array<string | null>, label: string) => {
		for (const p of paths) {
			if (p == null) continue;
			for (const segment of segmentsOf(p)) {
				expect(`${label}: ${segment}`).not.toContain('_');
			}
		}
	};

	it('holds for entityModuleNaming', () => {
		const n = entityModuleNaming(DEAL_STATE, MODULES_DIR);
		assertNoUnderscore([n.moduleDir, `${n.entityFile}.ts`, n.moduleFile, n.repositoryFile], 'entity');
	});

	it('holds for a context-nested entity', () => {
		const n = entityModuleNaming({ ...DEAL_STATE, context: 'sales_ops' }, MODULES_DIR);
		assertNoUnderscore([n.moduleDir, `${n.entityFile}.ts`, n.moduleFile, n.repositoryFile], 'context');
	});

	it('holds for a junction, whose name is always multi-word by construction', () => {
		// `junctionName([a, b])` is `${a}_${b}` — a junction can never be single-word,
		// so its folder and stems are the rule's permanent worst case.
		const n = entityModuleNaming({ name: 'opportunity_contact', plural: 'opportunity_contacts' }, MODULES_DIR);
		assertNoUnderscore([n.moduleDir, `${n.entityFile}.ts`, n.moduleFile, n.repositoryFile], 'junction');
	});

	it('holds for every stem shape the frontend and integration emitters build', () => {
		// The frontend names four per-entity files from the registry's `fileStem`;
		// the integration emitter names four more from `emittedStem(entityName)`.
		// Both were raw `${entity.name}` until NAME-2 — the "fourth spelling"
		// #684 exists to kill — so they are pinned here by the same property.
		const { name } = DEAL_STATE;
		const frontend = ['api', 'collections', 'entities', 'fields'].map(
			(dir) => `${dir}/${emittedStem(name)}.ts`,
		);
		const integration = [
			`${emittedStem(name)}.sink.generated.ts`,
			`${emittedStem(name)}.sink.ts`,
			`${emittedStem(name)}.change-emitter.ts`,
			`${emittedStem(name)}-integration.module.ts`,
		];
		for (const p of [...frontend, ...integration]) expect(p).not.toContain('_');
		expect(frontend[0]).toBe('api/deal-state.ts');
		expect(integration[3]).toBe('deal-state-integration.module.ts');
	});

	it('holds for every stem shape the backend pipeline builds', () => {
		const { name, plural } = DEAL_STATE;
		const stems = [
			emittedStem(name),
			emittedStem(plural),
			emittedStem('find', name, 'by-id'),
			emittedStem('find', name, 'by-id-with-fields'),
			emittedStem('list', plural),
			emittedStem('list', plural, 'with-fields'),
			emittedStem('create', name),
			emittedStem('update', name),
			emittedStem('delete', name),
			emittedStem('search', plural),
			emittedStem(name, 'output'),
			emittedStem(name, 'search'),
			emittedStem(name, 'integration-source'),
		];
		for (const stem of stems) expect(stem).not.toContain('_');
	});
});
