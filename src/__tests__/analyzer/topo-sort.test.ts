import { describe, it, expect } from 'bun:test';
import { buildDomainGraph, topoSortEntities } from '../../analyzer/index';
import type { ParsedEntity, ParsedRelationship } from '../../analyzer/types';

function entity(name: string, belongsTo: string[] = []): ParsedEntity {
	const relationships = new Map<string, ParsedRelationship>();
	for (const target of belongsTo) {
		relationships.set(target, {
			name: target,
			type: 'belongs_to',
			target,
			foreignKey: `${target}_id`,
			resolved: true,
		});
	}
	return {
		name,
		plural: `${name}s`,
		table: `${name}s`,
		folderStructure: 'nested',
		fields: new Map(),
		relationships,
		behaviors: [],
		sourcePath: `${name}.yaml`,
	};
}

describe('topoSortEntities', () => {
	it('orders dependents after their belongs_to targets', () => {
		const account = entity('account');
		const user = entity('user');
		const contact = entity('contact', ['account', 'user']);
		const entities = [contact, user, account];
		const graph = buildDomainGraph(entities);
		const { sorted, cycles } = topoSortEntities(entities, graph);

		const order = sorted.map((e) => e.name);
		expect(order.indexOf('account')).toBeLessThan(order.indexOf('contact'));
		expect(order.indexOf('user')).toBeLessThan(order.indexOf('contact'));
		expect(cycles).toHaveLength(0);
	});

	it('is alphabetically stable within a tier', () => {
		const a = entity('a');
		const b = entity('b');
		const c = entity('c');
		const graph = buildDomainGraph([c, a, b]);
		const { sorted } = topoSortEntities([c, a, b], graph);
		expect(sorted.map((e) => e.name)).toEqual(['a', 'b', 'c']);
	});

	it('treats self-references as non-dependencies', () => {
		const node = entity('node', ['node']);
		const graph = buildDomainGraph([node]);
		const { sorted, cycles } = topoSortEntities([node], graph);
		expect(sorted.map((e) => e.name)).toEqual(['node']);
		expect(cycles).toHaveLength(0);
	});

	it('breaks unresolvable cycles deterministically', () => {
		const a = entity('a', ['b']);
		const b = entity('b', ['a']);
		const graph = buildDomainGraph([a, b]);
		const { sorted, cycles } = topoSortEntities([a, b], graph);
		expect(sorted.map((e) => e.name)).toEqual(['a', 'b']);
		expect(cycles.length).toBeGreaterThan(0);
	});

	it('ignores belongs_to targets that are not in the input set', () => {
		const contact = entity('contact', ['account']);
		const graph = buildDomainGraph([contact]);
		const { sorted, cycles } = topoSortEntities([contact], graph);
		expect(sorted.map((e) => e.name)).toEqual(['contact']);
		expect(cycles).toHaveLength(0);
	});

	it('ignores has_many relationships for ordering', () => {
		const account: ParsedEntity = {
			...entity('account'),
			relationships: new Map([
				[
					'contacts',
					{
						name: 'contacts',
						type: 'has_many' as const,
						target: 'contact',
						foreignKey: 'account_id',
						resolved: true,
					},
				],
			]),
		};
		const contact = entity('contact', ['account']);
		const graph = buildDomainGraph([account, contact]);
		const { sorted, cycles } = topoSortEntities([account, contact], graph);
		expect(sorted.map((e) => e.name)).toEqual(['account', 'contact']);
		expect(cycles).toHaveLength(0);
	});
});
