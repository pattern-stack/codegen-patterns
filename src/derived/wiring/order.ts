/**
 * The class graph in dependency order (PW-1): the order a flat composition constructs the classes in, each after
 * everything its constructor takes. The plan's decision: **no class cycles, checked at generation** — a cycle is an
 * error naming it (`a → b → a`), as crew's `orderByNeeds` names a module cycle. Nest's `forwardRef` hid such
 * cycles; a flat composition can't construct one.
 *
 * Also: the cycles between contexts (d27, d29). A context's module may depend on another's only one way, so these
 * are reported for PW-3, which composes one module per context.
 */

import type { ClassGraph, ClassNode } from './types.js';

export class ClassCycleError extends Error {
	override readonly name = 'ClassCycleError';
	constructor(readonly cycle: readonly string[]) {
		super(`[codegen] generated classes take each other in a cycle: ${cycle.join(' → ')}`);
	}
}

/**
 * Every node, each after the nodes it takes, in a stable order (the graph's node order where nothing forces
 * otherwise). Throws `ClassCycleError` on a cycle, and an error naming both ends when a class takes one that no
 * entity or junction in the set emits.
 */
export function orderClasses(graph: ClassGraph): ClassNode[] {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const needs = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (!byId.has(edge.to)) {
			throw new Error(
				`[codegen] class graph: ${edge.from} takes ${edge.to} (${edge.reason}), which no entity or junction in the set emits`,
			);
		}
		needs.set(edge.from, [...(needs.get(edge.from) ?? []), edge.to]);
	}
	const done = new Set<string>();
	const out: ClassNode[] = [];
	const visit = (id: string, path: readonly string[]) => {
		if (done.has(id)) return;
		if (path.includes(id)) throw new ClassCycleError([...path.slice(path.indexOf(id)), id]);
		for (const next of needs.get(id) ?? []) visit(next, [...path, id]);
		done.add(id);
		out.push(byId.get(id) as ClassNode);
	};
	for (const node of graph.nodes) visit(node.id, []);
	return out;
}

/**
 * The cycles between contexts: context A's classes take B's and B's take A's, through any chain, including one
 * through an owner with no context (a junction, for which `contextOf` returns undefined): A → junction → B is A → B.
 * Each cycle once, as the contexts on it, starting from its smallest (`['billing', 'crm', 'billing']`).
 */
export function contextCycles(graph: ClassGraph, contextOf: (owner: string) => string | undefined): string[][] {
	const ownerOf = new Map(graph.nodes.map((n) => [n.id, n.owner]));
	const ownerDeps = new Map<string, Set<string>>();
	for (const edge of graph.edges) {
		const from = ownerOf.get(edge.from);
		if (from === undefined || from === edge.toOwner) continue;
		ownerDeps.set(from, (ownerDeps.get(from) ?? new Set()).add(edge.toOwner));
	}
	// The contexts an owner reaches directly, walking through context-less owners.
	const reachedContexts = (owner: string): Set<string> => {
		const out = new Set<string>();
		const seen = new Set<string>([owner]);
		const stack = [...(ownerDeps.get(owner) ?? [])];
		while (stack.length > 0) {
			const next = stack.pop() as string;
			if (seen.has(next)) continue;
			seen.add(next);
			const ctx = contextOf(next);
			if (ctx !== undefined) out.add(ctx);
			else stack.push(...(ownerDeps.get(next) ?? []));
		}
		return out;
	};
	const deps = new Map<string, Set<string>>();
	for (const owner of new Set(ownerOf.values())) {
		const from = contextOf(owner);
		if (from === undefined) continue;
		for (const to of reachedContexts(owner)) if (to !== from) deps.set(from, (deps.get(from) ?? new Set()).add(to));
	}
	const cycles: string[][] = [];
	const seen = new Set<string>();
	const walk = (ctx: string, path: string[]) => {
		const at = path.indexOf(ctx);
		if (at !== -1) {
			const cycle = path.slice(at);
			const first = cycle.indexOf([...cycle].sort()[0] as string);
			const rotated = [...cycle.slice(first), ...cycle.slice(0, first)];
			const key = rotated.join('→');
			if (!seen.has(key)) {
				seen.add(key);
				cycles.push([...rotated, rotated[0] as string]);
			}
			return;
		}
		for (const next of [...(deps.get(ctx) ?? [])].sort()) walk(next, [...path, ctx]);
	};
	for (const ctx of [...deps.keys()].sort()) walk(ctx, []);
	return cycles;
}
