/**
 * The class graph, per entity and per junction (PW-1). See `./types.ts`.
 *
 * An entity's classes and edges are read from its API surface (the class names, the use cases, the routes, and each
 * service / repository method's `delegatesTo`) and from its derivation input (the base it inherits, EAV, `emits:`).
 * No YAML is re-walked here: a `belongs_to` / `has_many` composition is the surface's delegate onto another
 * entity's repository, and a junction fan-out its delegate onto a junction's service.
 */

import { junctionName } from '../../config/junction-naming.js';
import type { EntityApiInput } from '../api/entity.js';
import { repositoryClassName, serviceClassName } from '../api/names.js';
import type { EntityApiSurface, MethodRef } from '../api/types.js';
import type {
	ClassEdge,
	ClassEdgeReason,
	ClassGraph,
	ClassNode,
	ModuleImport,
	ModuleImportReason,
	SystemDependency,
} from './types.js';

/** The entity whose service an EAV entity's classes take (`FieldValueService`, ADR-13). Its name is fixed. */
export const EAV_FIELD_VALUE_ENTITY = 'field_value';

/** A junction's name and its two ends, as `between:` lists them. */
export interface JunctionClassInput {
	name: string;
	left: string;
	right: string;
}

function classGraph(): ClassGraph & { add(edge: ClassEdge): void } {
	const nodes: ClassNode[] = [];
	const edges: ClassEdge[] = [];
	return {
		nodes,
		edges,
		add(edge) {
			if (!edges.some((e) => e.from === edge.from && e.to === edge.to)) edges.push(edge);
		},
	};
}

type Target = Pick<ClassEdge, 'to' | 'toOwner' | 'toOwnerKind'>;

const repositoryOf = (entity: string, kind: ClassEdge['toOwnerKind'] = 'entity'): Target => ({
	to: repositoryClassName(entity),
	toOwner: entity,
	toOwnerKind: kind,
});
const serviceOf = (owner: string, kind: ClassEdge['toOwnerKind'] = 'entity'): Target => ({
	to: serviceClassName(owner),
	toOwner: owner,
	toOwnerKind: kind,
});

/** The class a delegate's target method lives on, and whether its owner is a junction (one of `junctions`). */
function targetOf(ref: MethodRef, junctions: ReadonlySet<string>): Target {
	const kind = junctions.has(ref.entity) ? 'junction' : 'entity';
	return ref.layer === 'repository' ? repositoryOf(ref.entity, kind) : serviceOf(ref.entity, kind);
}

export function entityClassGraph(input: EntityApiInput, surface: EntityApiSurface): ClassGraph {
	const definition = input.definition;
	const self = definition.entity.name;
	const base = input.inheritanceBase?.name ?? null;
	const eav = definition.eav === true;
	const eavDefinition = definition.eav_value_table === true ? (definition.eav_definition_table ?? null) : null;
	const emits = new Set(definition.emits ?? []);
	const fieldValues = serviceOf(EAV_FIELD_VALUE_ENTITY);
	const junctions = new Set(
		input.junctions.filter((j) => j.between.length === 2).map((j) => junctionName([j.between[0] ?? '', j.between[1] ?? ''])),
	);
	const local = (to: string): Target => ({ to, toOwner: self, toOwnerKind: 'entity' });

	const g = classGraph();
	const repository = surface.repository.className;
	const service = surface.service.className;
	const node = (id: string, role: ClassNode['role'], systems: SystemDependency[], useCaseKind?: string) =>
		g.nodes.push({ id, owner: self, ownerKind: 'entity', role, systems, ...(useCaseKind ? { useCaseKind } : {}) });

	// ── The repository: `db`, the base's repository (a child), `FieldValueService` (EAV) ──
	node(repository, 'repository', ['db']);
	if (base) g.add({ from: repository, ...repositoryOf(base), reason: 'inherits' });
	if (eav) g.add({ from: repository, ...fieldValues, reason: 'eav_field_values' });
	for (const m of surface.repository.methods) {
		const to = m.delegatesTo;
		if (to && to.entity !== self) {
			g.add({ from: repository, ...targetOf(to, junctions), reason: to.entity === base ? 'inherits' : 'composes' });
		}
	}

	// ── The service: its repository, EAV, then every other entity's repository or junction's service it delegates to ──
	node(service, 'service', ['event_bus']);
	g.add({ from: service, ...local(repository), reason: 'own' });
	if (eav) g.add({ from: service, ...fieldValues, reason: 'eav_field_values' });
	if (eavDefinition) g.add({ from: service, ...repositoryOf(eavDefinition), reason: 'eav_definition' });
	for (const m of surface.service.methods) {
		const to = m.delegatesTo;
		if (!to || to.entity === self) continue;
		const reason: ClassEdgeReason = junctions.has(to.entity)
			? 'junction_fan_out'
			: to.entity === base
				? 'inherits'
				: 'composes';
		g.add({ from: service, ...targetOf(to, junctions), reason });
	}

	// ── The use cases ──
	const listUseCase = surface.useCases.find((u) => u.kind === 'list')?.className;
	for (const u of surface.useCases) {
		const event = { create: 'created', update: 'updated', delete: 'deleted' }[u.kind as 'create' | 'update' | 'delete'];
		const publishes = event !== undefined && emits.has(`${self}_${event}`);
		// A write takes `db` when it opens a transaction: to publish its event in it, or (create / update) to write
		// an EAV entity's values in it.
		const transactional = publishes || (eav && (u.kind === 'create' || u.kind === 'update'));
		const systems: SystemDependency[] = transactional ? ['db', ...(publishes ? (['typed_event_bus'] as const) : [])] : [];
		node(u.className, 'use_case', systems, u.kind);
		if (u.kind === 'search' && listUseCase) {
			g.add({ from: u.className, ...local(listUseCase), reason: 'list_use_case' });
			continue;
		}
		g.add({ from: u.className, ...local(service), reason: 'own' });
		if (eav && (u.kind === 'create' || u.kind === 'update')) {
			g.add({ from: u.className, ...fieldValues, reason: 'eav_field_values' });
		}
	}

	// ── The controllers: one per route's controller, taking the use cases its routes call ──
	for (const route of surface.http.routes) {
		if (!g.nodes.some((n) => n.id === route.controller)) node(route.controller, 'controller', []);
		g.add({ from: route.controller, ...local(route.useCase), reason: 'route' });
	}

	return { nodes: g.nodes, edges: g.edges };
}

export function junctionClassGraph(junction: JunctionClassInput): ClassGraph {
	const g = classGraph();
	const repository = repositoryClassName(junction.name);
	const service = serviceClassName(junction.name);
	const owner = { owner: junction.name, ownerKind: 'junction' as const };
	g.nodes.push({ id: repository, ...owner, role: 'repository', systems: ['db'] });
	g.nodes.push({ id: service, ...owner, role: 'service', systems: [] });
	g.add({ from: service, to: repository, toOwner: junction.name, toOwnerKind: 'junction', reason: 'own' });
	g.add({ from: service, ...repositoryOf(junction.left), reason: 'junction_end' });
	g.add({ from: service, ...repositoryOf(junction.right), reason: 'junction_end' });
	return { nodes: g.nodes, edges: g.edges };
}

/** The order a module files its imports in: the base it is a kind of first, the EAV blocks last. */
const MODULE_IMPORT_ORDER: readonly ModuleImportReason[] = [
	'inherits',
	'composes',
	'junction_end',
	'junction_fan_out',
	'eav_field_values',
	'eav_definition',
];

/**
 * Which reason a module reached for several is filed under: `inherits` over everything (a child's base comes
 * first, once, even when the child also relates to it); then the EAV blocks and junction fan-out over a plain
 * composition (the EAV definition's module is the EAV block's, even when a relationship composes it too).
 */
const FILED_UNDER: readonly ModuleImportReason[] = [
	'inherits',
	'eav_definition',
	'eav_field_values',
	'junction_fan_out',
	'junction_end',
	'composes',
];

const CROSSES_MODULES = new Set<ClassEdgeReason>(MODULE_IMPORT_ORDER);

/**
 * The modules `owner`'s module imports: the owner of every class one of its classes takes, other than itself, each
 * once, ordered by `MODULE_IMPORT_ORDER` and, within a reason, by first appearance (edges in the order the graph
 * adds them: the repository's, the service's in constructor order, then the use cases').
 */
export function moduleImports(graph: ClassGraph, owner: string): ModuleImport[] {
	const own = new Set(graph.nodes.filter((n) => n.owner === owner).map((n) => n.id));
	const reached = new Map<string, { ownerKind: ModuleImport['ownerKind']; reasons: Set<ModuleImportReason> }>();
	for (const edge of graph.edges) {
		if (!own.has(edge.from) || edge.toOwner === owner || !CROSSES_MODULES.has(edge.reason)) continue;
		const entry = reached.get(edge.toOwner) ?? { ownerKind: edge.toOwnerKind, reasons: new Set() };
		entry.reasons.add(edge.reason as ModuleImportReason);
		reached.set(edge.toOwner, entry);
	}
	const filed = [...reached].map(([name, { ownerKind, reasons }]) => ({
		owner: name,
		ownerKind,
		reason: FILED_UNDER.find((r) => reasons.has(r)) as ModuleImportReason,
	}));
	return MODULE_IMPORT_ORDER.flatMap((reason) => filed.filter((m) => m.reason === reason));
}

/** Two owners emit a class of one name (an entity named like a junction, `account_contact`). */
export class DuplicateClassError extends Error {
	override readonly name = 'DuplicateClassError';
	constructor(readonly className: string, readonly first: string, readonly second: string) {
		super(`[codegen] class graph: ${className} is emitted by both ${first} and ${second}`);
	}
}

/** Two graphs as one (a project's entities and junctions). A class emitted twice is a `DuplicateClassError`. */
export function mergeClassGraphs(graphs: readonly ClassGraph[]): ClassGraph {
	const nodes: ClassNode[] = [];
	const seen = new Map<string, string>();
	for (const g of graphs) {
		for (const n of g.nodes) {
			const other = seen.get(n.id);
			if (other !== undefined) throw new DuplicateClassError(n.id, other, n.owner);
			seen.set(n.id, n.owner);
			nodes.push(n);
		}
	}
	return { nodes, edges: graphs.flatMap((g) => g.edges) };
}
