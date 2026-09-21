/**
 * Frontend emitter — the CLIENT relation graph (ADR-038, ADR-044 §5, FE-REL).
 *
 * ADR-044 restated Electric parity as "both sides project from the same
 * declared graph". This module is the client half of that sentence, and it
 * keeps the promise literally: it calls **REL-1's own builder**
 * (`src/emitters/relations/build-graph.ts`) a second time and projects its
 * edges onto the browser's collections. There is no second traversal of the
 * YAML, no second place relationship semantics live, and no re-pluralization
 * anywhere — every name is the registry's (`entity.plural`) or REL-1's junction
 * identity (charter I1, and the ADR-038 rule restated in CLAUDE.md).
 *
 * The projection is a narrowing, not a translation:
 *
 *  - **keys are the same.** A collection key is `entity.plural`, which is
 *    exactly the table identifier REL-1 emits for that entity; a junction's is
 *    REL-1's `tableVar`. So `graph.ts` and `relations.ts` name the same edge the
 *    same way on both sides of the wire (§6.2 asserts this mechanically).
 *  - **junction rows are not roots in v1.** REL-1 emits the junction table's own
 *    two `one()` edges so `db.query.opportunityContacts.findMany({ with: … })`
 *    works server-side. The client store has no entry for a junction (the
 *    frontend set is the ENTITY registry), so there is nothing to hang
 *    `.from(id)` on. Those edges are dropped here and reported, never silently.
 *  - **a hop that cannot be executed is a generation error**, not a degraded
 *    fetch loop — see {@link CrossSyncModeHopError}.
 */

import type { EntityDefinition } from '../../schema/entity-definition.schema';
import type { JunctionDefinition } from '../../schema/junction-definition.schema';
import { buildRelationGraph, junctionIdentity } from '../relations/build-graph';
import { camelCase } from '../relations/types';
import type {
	EntityRegistryEntry,
	FrontendEmitConfig,
	FrontendEmitContext,
	SyncMode,
} from './types';
import { resolveSyncMode, sortEntities } from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A hop whose participants do not all sync the same way.
 *
 * v1 traversal is a live query over LOCAL collections, so every collection a
 * hop touches — the root, the target, and the junction when the hop goes
 * through one — has to be in the browser. An `electric` root reaching an `api`
 * target has nothing local to join against.
 *
 * This is a generation error rather than a silent degradation on purpose
 * (FE-REL §4.4, gate decision 3): the alternative is a fetch-per-row bridge,
 * which is the N+1 charter I4 exists to forbid. The v2 shape is recorded in the
 * message so the fix is one link away — one id-set request per level
 * (`?where[<fk>][in]=…`), which needs a list-filter contract REL-2's include
 * allowlist does not yet define.
 */
export class CrossSyncModeHopError extends Error {
	constructor(
		readonly sourceEntity: string,
		readonly targetEntity: string,
		readonly relation: string,
		readonly sourceMode: SyncMode,
		readonly targetMode: SyncMode,
	) {
		super(
			`cross-mode relation '${relation}': '${sourceEntity}' syncs '${sourceMode}' but ` +
				`'${targetEntity}' syncs '${targetMode}'. ` +
				`A client-side traversal is a live query over local collections, so every entity on ` +
				`the hop must sync the same way. Fix it by giving both the same \`sync:\` mode, or by ` +
				`removing the relation from the frontend set. Bridging the boundary with one id-set ` +
				`request per level is the v2 design (docs/specs/FE-REL.md §4.4) and needs a list-filter ` +
				`contract REL-2's include allowlist does not define yet — it is deliberately not ` +
				`degraded to a fetch-per-row loop here (charter I4).`,
		);
		this.name = 'CrossSyncModeHopError';
	}
}

// ---------------------------------------------------------------------------
// Naming records
// ---------------------------------------------------------------------------

/**
 * A junction's client-side naming record — the junction analogue of an
 * {@link EntityRegistryEntry}.
 *
 * Every field is derived from REL-1's {@link junctionIdentity} (the pairing IS
 * the name) plus the same `camelCase`/`pascalCase` derivations the entity
 * registry uses, so a junction and an entity are named by one rule.
 */
export interface JunctionCollectionEntry {
	/** `opportunity_contact` — REL-1's junction name. */
	name: string;
	/** `opportunity_contacts` — the table, and the graph key's source. */
	plural: string;
	/** `opportunityContacts` — REL-1's `tableVar`, and the client graph key. */
	collectionKey: string;
	/** `opportunityContact` — the emitted `<camelName>Collection` export. */
	camelName: string;
	/** `OpportunityContact` — the row type imported from `dbEntities`. */
	className: string;
	/** The two FK column properties, camelCased, in `between:` order. */
	keyColumns: [string, string];
}

const pascalCase = (s: string): string => {
	const camel = camelCase(s);
	return camel.charAt(0).toUpperCase() + camel.slice(1);
};

/** Build a junction's client naming record from its definition. */
export function junctionCollectionEntry(
	def: JunctionDefinition,
): JunctionCollectionEntry {
	const { name, plural, tableVar } = junctionIdentity(def);
	return {
		name,
		plural,
		collectionKey: tableVar,
		camelName: camelCase(name),
		className: pascalCase(name),
		keyColumns: [
			camelCase(`${def.between[0]}_id`),
			camelCase(`${def.between[1]}_id`),
		],
	};
}

// ---------------------------------------------------------------------------
// The client graph
// ---------------------------------------------------------------------------

/** One navigable edge, as it appears under `graph.<collection>.<key>`. */
export interface ClientRelation {
	/** Relation key — the YAML relationship name camelCased (REL-1's key). */
	key: string;
	kind: 'one' | 'many';
	/** The TARGET's graph key (`entity.plural`, or a junction's `collectionKey`). */
	target: string;
	/** Column on the source row. */
	from: string;
	/** Column on the target row. */
	to: string;
	/** Many-to-many: the junction collection the hop passes through. */
	through?: { collection: string; from: string; to: string };
	/** `one` only — whether the joined row may be absent. */
	optional?: boolean;
}

/** Everything the graph emitters need about one navigable collection. */
export interface ClientGraphNode {
	/** Graph key — `entity.plural` for an entity, `collectionKey` for a junction. */
	collection: string;
	/** The registry entry, when this node is an entity. Junction nodes carry one instead. */
	entity?: EntityRegistryEntry;
	junction?: JunctionCollectionEntry;
	relations: ClientRelation[];
}

export interface ClientGraph {
	/** Navigable nodes, collection-key sorted. Junction nodes carry no relations in v1. */
	nodes: ClientGraphNode[];
	/** Junctions in the set that need a collection emitting, name-sorted. */
	junctions: JunctionCollectionEntry[];
	/**
	 * Entities whose accessors are deliberately NOT emitted, with the reason.
	 * Rendered into `graph.ts` and surfaced by the CLI — a deferral that is
	 * visible in the output is not a silent drop (charter I9).
	 */
	deferred: Array<{ entity: string; reason: string }>;
	/** Everything REL-1 warned about, plus this projection's own drops. */
	warnings: string[];
}

/**
 * Resolve a junction's effective sync mode. A junction YAML declares no
 * `sync:` — `JunctionDefinitionSchema` is `.strict()` and has no such key — so
 * it follows the global default. Its rows reach the browser the same way an
 * `electric` entity's do (a shape over its table); there is no REST surface for
 * them, because `junction new` emits no controller.
 */
function junctionSyncMode(config: FrontendEmitConfig): SyncMode {
	return config.globalSyncMode;
}

/**
 * Project REL-1's relation graph onto the client's collections.
 *
 * @throws {CrossSyncModeHopError} when an `electric` root reaches a target (or
 *   passes through a junction) that does not sync the same way.
 */
export function buildClientGraph(ctx: FrontendEmitContext): ClientGraph {
	const definitions: Map<string, EntityDefinition> = ctx.definitions ?? new Map();
	const junctionDefs: JunctionDefinition[] = ctx.junctions ?? [];
	const entities = sortEntities(ctx.entities);

	const junctions = junctionDefs
		.map(junctionCollectionEntry)
		.sort((a, b) => a.name.localeCompare(b.name));
	const junctionByKey = new Map(junctions.map((j) => [j.collectionKey, j]));
	const junctionKeys = new Set(junctionByKey.keys());

	// The single source of relationship semantics — REL-1's builder, unchanged.
	const { tables, warnings } = buildRelationGraph({
		entities,
		definitions,
		junctions: junctionDefs,
	});

	const byPlural = new Map(entities.map((e) => [e.plural, e]));
	const modeOf = (e: EntityRegistryEntry): SyncMode => resolveSyncMode(e, ctx.config);
	const jMode = junctionSyncMode(ctx.config);

	const nodes: ClientGraphNode[] = [];
	const deferred: Array<{ entity: string; reason: string }> = [];
	const localWarnings: string[] = [];

	for (const { table, edges } of tables) {
		if (junctionKeys.has(table)) {
			// REL-1 emits the junction's own two `one()` edges for the server's
			// `db.query.<junction>.findMany({ with: … })`. The client store has no
			// entry for a junction, so there is no `.from(id)` root to hang them on.
			localWarnings.push(
				`junction '${table}': its own belongs_to edges are not client-navigable in v1 — ` +
					`a junction has no store entry to root a traversal on. Reach its rows as a ` +
					`to-many hop from either parent instead (graph.<parent>.${table}).`,
			);
			continue;
		}

		const entity = byPlural.get(table);
		if (!entity) {
			localWarnings.push(
				`table '${table}' has relations in the manifest but no entity in the frontend ` +
					`registry — no accessors emitted for it`,
			);
			continue;
		}

		const sourceMode = modeOf(entity);
		const relations: ClientRelation[] = [];

		for (const edge of edges) {
			const targetJunction = junctionByKey.get(edge.targetTable);
			const targetEntity = byPlural.get(edge.targetTable);
			const targetName = targetJunction?.name ?? targetEntity?.name;
			const targetMode = targetJunction ? jMode : targetEntity ? modeOf(targetEntity) : null;

			if (targetMode === null || targetName === undefined) {
				localWarnings.push(
					`${entity.name}.${edge.key}: target '${edge.targetTable}' is not in the frontend ` +
						`set — relation skipped`,
				);
				continue;
			}

			// v1 traversal is local-only. Every participant must be `electric` or
			// there is nothing in the browser to join. An `api` ROOT is a separate,
			// documented deferral (below), not an error.
			// One rule covers every case, including a junction that cannot reach the
			// browser: REL-1 emits the row-level edge to the link table alongside
			// every `through` hop, so a junction whose mode is wrong is always
			// caught by this same check on that edge. There is no separate junction
			// branch because there is no state in which one would fire first.
			if (sourceMode === 'electric' && targetMode !== 'electric') {
				throw new CrossSyncModeHopError(
					entity.name,
					targetName,
					edge.key,
					sourceMode,
					targetMode,
				);
			}

			relations.push({
				key: edge.key,
				kind: edge.cardinality,
				target: edge.targetTable,
				from: edge.from.column,
				to: edge.to.column,
				...(edge.from.through && edge.to.through
					? {
							through: {
								collection: edge.from.through.table,
								from: edge.from.through.column,
								to: edge.to.through.column,
							},
						}
					: {}),
				...(edge.optional !== undefined ? { optional: edge.optional } : {}),
			});
		}

		if (sourceMode !== 'electric') {
			// FE-REL §4.3: the `api` half compiles to ONE request against REL-2's
			// allowlisted dot-path include. REL-2 (#587) is what defines that
			// allowlist, so the accessors cannot be emitted before it lands. The
			// edges are still in the descriptor — only the accessors wait.
			deferred.push({
				entity: entity.name,
				reason:
					`sync: api — accessors compile to REL-2's allowlisted \`?include=\` request ` +
					`(FE-REL §4.3), which is not in this unit`,
			});
		}

		nodes.push({ collection: table, entity, relations });
	}

	// Junction nodes carry no relations (see header) but DO appear in the
	// descriptor, so a consumer reading `graph` sees the whole shape.
	for (const junction of junctions) {
		nodes.push({ collection: junction.collectionKey, junction, relations: [] });
	}
	nodes.sort((a, b) => a.collection.localeCompare(b.collection));

	return {
		nodes,
		junctions,
		deferred,
		warnings: [...warnings, ...localWarnings],
	};
}

/**
 * The entities that get an accessor module: `electric`, and with at least one
 * navigable relation. Everything excluded is in {@link ClientGraph.deferred} or
 * simply has no edges.
 */
export function accessorNodes(graph: ClientGraph, ctx: FrontendEmitContext): ClientGraphNode[] {
	const deferredNames = new Set(graph.deferred.map((d) => d.entity));
	return graph.nodes.filter(
		(n) =>
			n.entity !== undefined &&
			n.relations.length > 0 &&
			!deferredNames.has(n.entity.name) &&
			resolveSyncMode(n.entity, ctx.config) === 'electric',
	);
}
