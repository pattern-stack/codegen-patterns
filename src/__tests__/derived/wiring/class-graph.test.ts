/**
 * The class graph (PW-1): every fixture set's generated classes form a chain (no class cycle), the cycle check names
 * a cycle when there is one, and `moduleImports` files a module under its strongest reason, in Nest's import order.
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import { loadProjectApiContext } from '../../../derived/api/project';
import { moduleImports } from '../../../derived/wiring/classes';
import { ClassCycleError, contextCycles, orderClasses } from '../../../derived/wiring/order';
import { deriveProjectClassGraph } from '../../../derived/wiring/project';
import type { ClassEdge, ClassGraph, ClassNode } from '../../../derived/wiring/types';

const ROOT = path.resolve(import.meta.dir, '../../../..');

/** Every fixture set a gate generates (baseline, junction, inheritance, scaffold, smoke, goldens). */
const SETS: Array<{ name: string; entities: string; junctions?: string }> = [
	{ name: 'baseline', entities: 'test/fixtures/entities' },
	{ name: 'inheritance', entities: 'test/fixtures/inheritance/entities' },
	{ name: 'scaffold', entities: 'test/scaffold/entities', junctions: 'test/scaffold/junctions' },
	{ name: 'relations-golden', entities: 'test/relations-golden/entities', junctions: 'test/relations-golden/junctions' },
	{ name: 'semantic-golden', entities: 'test/semantic-golden/entities', junctions: 'test/semantic-golden/junctions' },
	{ name: 'frontend-golden', entities: 'test/frontend-golden/entities' },
	{ name: 'smoke-junction', entities: 'test/smoke/fixtures-junction/entities', junctions: 'test/smoke/fixtures-junction/junctions' },
	{
		name: 'smoke-junction-cross-domain',
		entities: 'test/smoke/fixtures-junction-cross-domain/entities',
		junctions: 'test/smoke/fixtures-junction-cross-domain/junctions',
	},
	{ name: 'smoke-frontend', entities: 'test/smoke/fixtures-frontend/entities', junctions: 'test/smoke/fixtures-frontend/junctions' },
];

function load(set: (typeof SETS)[number]) {
	return loadProjectApiContext(ROOT, null, {
		entitiesDir: path.join(ROOT, set.entities),
		junctionsDir: path.join(ROOT, set.junctions ?? `${set.entities}/__none__`),
		relationshipsDir: path.join(ROOT, `${set.entities}/__none__`),
	}).relations;
}

describe('every fixture set’s classes form a chain', () => {
	for (const set of SETS) {
		it(`${set.name}: no class cycle, and every class a constructor takes is emitted`, () => {
			const { graph, order } = deriveProjectClassGraph(load(set));
			expect(graph.nodes.length).toBeGreaterThan(0);
			expect(order).toHaveLength(graph.nodes.length);
			const at = new Map(order.map((n, i) => [n.id, i]));
			for (const edge of graph.edges) expect(at.get(edge.to)!).toBeLessThan(at.get(edge.from)!);
		});
	}

	it('junction sets carry junction classes and fan-out edges', () => {
		const { graph } = deriveProjectClassGraph(load(SETS.find((s) => s.name === 'smoke-junction')!));
		expect(graph.nodes.some((n) => n.ownerKind === 'junction' && n.role === 'service')).toBe(true);
		expect(graph.edges.some((e) => e.reason === 'junction_fan_out')).toBe(true);
		expect(graph.edges.some((e) => e.reason === 'junction_end')).toBe(true);
	});

	it('the inheritance set carries the child → base repository edge', () => {
		const { graph } = deriveProjectClassGraph(load(SETS[1]!));
		expect(graph.edges.some((e) => e.reason === 'inherits')).toBe(true);
	});
});

// ── Synthetic graphs ──

const n = (id: string, owner: string, role: ClassNode['role'] = 'service'): ClassNode => ({
	id,
	owner,
	ownerKind: 'entity',
	role,
	systems: [],
});
const e = (from: string, to: string, toOwner: string, reason: ClassEdge['reason']): ClassEdge => ({
	from,
	to,
	toOwner,
	toOwnerKind: 'entity',
	reason,
});

describe('orderClasses', () => {
	it('names a cycle', () => {
		const graph: ClassGraph = {
			nodes: [n('A', 'a'), n('B', 'b'), n('C', 'c')],
			edges: [e('A', 'B', 'b', 'composes'), e('B', 'C', 'c', 'composes'), e('C', 'A', 'a', 'composes')],
		};
		expect(() => orderClasses(graph)).toThrow(ClassCycleError);
		expect(() => orderClasses(graph)).toThrow('A → B → C → A');
	});

	it('refuses a class that takes one nobody emits', () => {
		expect(() => orderClasses({ nodes: [n('A', 'a')], edges: [e('A', 'Ghost', 'ghost', 'composes')] })).toThrow(
			/A takes Ghost/,
		);
	});
});

describe('contextCycles', () => {
	it('reports a cycle between contexts once, and none for a DAG', () => {
		const graph: ClassGraph = {
			nodes: [n('A', 'a'), n('B', 'b'), n('C', 'c')],
			edges: [e('A', 'B', 'b', 'composes'), e('B', 'A', 'a', 'composes'), e('B', 'C', 'c', 'composes')],
		};
		const ctx = { a: 'crm', b: 'billing', c: 'ops' } as Record<string, string>;
		expect(contextCycles(graph, (o) => ctx[o])).toEqual([['billing', 'crm', 'billing']]);
		expect(contextCycles({ ...graph, edges: graph.edges.slice(1) }, (o) => ctx[o])).toEqual([]);
	});

	it('follows a chain through a context-less owner (a junction)', () => {
		const graph: ClassGraph = {
			nodes: [n('A', 'a'), n('J', 'j'), n('B', 'b'), n('K', 'k')],
			edges: [e('A', 'J', 'j', 'junction_fan_out'), e('J', 'B', 'b', 'junction_end'), e('B', 'K', 'k', 'junction_fan_out'), e('K', 'A', 'a', 'junction_end')],
		};
		const ctx = { a: 'crm', b: 'billing' } as Record<string, string>;
		expect(contextCycles(graph, (o) => ctx[o])).toEqual([['billing', 'crm', 'billing']]);
	});

	it('keeps two cycles over the same contexts in different directions apart', () => {
		const graph: ClassGraph = {
			nodes: [n('A', 'a'), n('B', 'b'), n('C', 'c')],
			edges: [
				e('A', 'B', 'b', 'composes'),
				e('B', 'C', 'c', 'composes'),
				e('C', 'A', 'a', 'composes'),
				e('A', 'C', 'c', 'composes'),
				e('C', 'B', 'b', 'composes'),
				e('B', 'A', 'a', 'composes'),
			],
		};
		const cycles = contextCycles(graph, (o) => o).map((c) => c.join(' '));
		expect(cycles).toContain('a b c a');
		expect(cycles).toContain('a c b a');
	});
});

describe('moduleImports', () => {
	it('files the base first and the EAV definition last, each owner once, others in first-appearance order', () => {
		const graph: ClassGraph = {
			nodes: [n('ChildRepository', 'child', 'repository'), n('ChildService', 'child')],
			edges: [
				e('ChildRepository', 'BaseRepository', 'base', 'inherits'),
				e('ChildService', 'ChildRepository', 'child', 'own'),
				e('ChildService', 'DefRepository', 'def', 'composes'),
				e('ChildService', 'ZedRepository', 'zed', 'composes'),
				e('ChildService', 'BaseRepository', 'base', 'composes'),
				e('ChildService', 'AlphaRepository', 'alpha', 'composes'),
				e('ChildService', 'DefRepository', 'def', 'eav_definition'),
			],
		};
		expect(moduleImports(graph, 'child').map((m) => `${m.reason}:${m.owner}`)).toEqual([
			'inherits:base',
			'composes:zed',
			'composes:alpha',
			'eav_definition:def',
		]);
	});
});
