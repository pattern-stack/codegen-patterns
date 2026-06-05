/**
 * Frontend emitter — store / resolvers / lookups tests (ADR-038, FE-3).
 *
 * Headline cases:
 *  - createStore keys are PLURALS (not table).
 *  - FK resolution uses REGISTRY names: a `task.assignee_id` belongs_to → `person`
 *    (irregular plural `people`) resolves to `peopleCollection` / `people` keys,
 *    never `persons`.
 *  - A self-referential FK (target === self) does not produce a duplicate import.
 */

import { describe, expect, it } from 'bun:test';
import {
	buildStoreIndexFile,
	buildResolversFile,
	buildLookupsFile,
	buildStoreModuleIndexFile,
	resolvableRels,
} from '../../../emitters/frontend/emit-store';
import {
	ctx,
	entry,
	field,
	parsedEntity,
	parsedMap,
	relationship,
} from './_helpers';

/** Two-entity fixture: `person` (plural `people`) referenced by `task.assignee_id`. */
function personTaskCtx() {
	const person = entry('person', 'people');
	const task = entry('task', 'tasks');
	const parsed = parsedMap(
		parsedEntity(person),
		parsedEntity(task, {
			fields: new Map([
				['assignee_id', field('assignee_id', { foreignKey: { table: 'people', column: 'id' } })],
			]),
			relationships: new Map([
				[
					'assignee',
					relationship('assignee', { target: 'person', foreignKey: 'assignee_id' }),
				],
			]),
		}),
	);
	return { person, task, c: ctx([person, task], {}, parsed) };
}

describe('emit-store — createStore (store/index.ts)', () => {
	it('keys entities + collections by PLURAL, not table', () => {
		// table diverges from plural on purpose.
		const e = { ...entry('person', 'people'), table: 'tbl_persons' };
		const c = ctx([e]);
		const out = buildStoreIndexFile(c);
		expect(out).toContain('people: personHooks,');
		expect(out).toContain('people: personCollection,');
		expect(out).not.toContain('tbl_persons:');
		expect(out).not.toContain('persons:');
	});

	it('imports createStore + per-entity hooks and collections; exports AppStore', () => {
		const { c } = personTaskCtx();
		const out = buildStoreIndexFile(c);
		expect(out).toContain(
			"import { createStore } from '@pattern-stack/frontend-patterns';",
		);
		expect(out).toContain("import { personHooks } from '../entities/person';");
		expect(out).toContain(
			"import { taskCollection } from '../collections/task';",
		);
		expect(out).toContain('export type AppStore = typeof store;');
	});
});

describe('emit-store — resolvers (store/resolvers.ts)', () => {
	it('resolves the FK via registry names (people, not persons)', () => {
		const { c } = personTaskCtx();
		const out = buildResolversFile(c);
		// Resolver table is keyed by singular camelName.
		expect(out).toContain('person: (id) => {');
		expect(out).toContain('return personCollection.state.get(id)');
		expect(out).not.toContain('persons');

		// Task gets a TaskRefs hydrator that calls resolvers.person on assigneeId.
		expect(out).toContain('export interface TaskRefs {');
		expect(out).toContain('assignee: Person | undefined;');
		expect(out).toContain('resolvers.person(entity.assigneeId)');
	});

	it('resolvableRels resolves target naming from the registry', () => {
		const { task, c } = personTaskCtx();
		const rels = resolvableRels(task, c);
		expect(rels).toHaveLength(1);
		expect(rels[0]?.target.plural).toBe('people');
		expect(rels[0]?.target.className).toBe('Person');
		expect(rels[0]?.propertyName).toBe('assignee');
		expect(rels[0]?.fieldNameCamel).toBe('assigneeId');
	});

	it('drops belongs_to whose target is absent from the registry', () => {
		const task = entry('task', 'tasks');
		const parsed = parsedMap(
			parsedEntity(task, {
				relationships: new Map([
					['owner', relationship('owner', { target: 'ghost', foreignKey: 'owner_id' })],
				]),
			}),
		);
		const c = ctx([task], {}, parsed);
		expect(resolvableRels(task, c)).toHaveLength(0);
		const out = buildResolversFile(c);
		expect(out).not.toContain('TaskRefs');
	});

	it('self-referential FK does not duplicate the entity import', () => {
		const category = entry('category', 'categories');
		const parsed = parsedMap(
			parsedEntity(category, {
				fields: new Map([
					['parent_id', field('parent_id', { foreignKey: { table: 'categories', column: 'id' } })],
				]),
				relationships: new Map([
					['parent', relationship('parent', { target: 'category', foreignKey: 'parent_id' })],
				]),
			}),
		);
		const c = ctx([category], {}, parsed);
		const out = buildResolversFile(c);

		// Exactly one collection import and one type import for the entity.
		const collImports = out.match(
			/import \{ categoryCollection \} from '\.\.\/collections\/category';/g,
		);
		const typeImports = out.match(
			/import type \{ Category \} from '@repo\/db\/entities\/category';/g,
		);
		expect(collImports).toHaveLength(1);
		expect(typeImports).toHaveLength(1);

		// Self-ref hydrator wires resolvers.category over its own parentId.
		expect(out).toContain('export interface CategoryRefs {');
		expect(out).toContain('parent: Category | undefined;');
		expect(out).toContain('resolvers.category(entity.parentId)');
	});
});

describe('emit-store — lookups (store/lookups.ts)', () => {
	it('keys lookup maps by plural and builds from collection state', () => {
		const { c } = personTaskCtx();
		const out = buildLookupsFile(c);
		expect(out).toContain('people: Map<string, Person>;');
		expect(out).toContain('tasks: Map<string, Task>;');
		expect(out).toContain('Array.from(personCollection.state.values())');
		expect(out).toContain('export function createLookups()');
	});
});

describe('emit-store — module-index (store/module-index.ts)', () => {
	it('re-exports store, resolver + lookup factories, and only entities with refs', () => {
		const { c } = personTaskCtx();
		const out = buildStoreModuleIndexFile(c);
		expect(out).toContain("export { store, type AppStore } from './index';");
		expect(out).toContain(
			"export { createResolvers, type Resolvers } from './resolvers';",
		);
		expect(out).toContain(
			"export { buildLookups, createLookups, type EntityLookups } from './lookups';",
		);
		// task has a ref hydrator; person does not.
		expect(out).toContain(
			"export { resolveTaskRefs, type TaskRefs } from './resolvers';",
		);
		expect(out).not.toContain('resolvePersonRefs');
	});
});
