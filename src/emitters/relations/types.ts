/**
 * Relations emitter — shared types (ADR-044, REL-1).
 *
 * The manifest is a CROSS-ENTITY file: one `defineRelations()` per schema,
 * rendered from the full entity + junction set in one pass. So, like the
 * frontend emitter (ADR-038), it is a whole-set TS emitter rather than a hygen
 * template — there is no per-entity file to inject into.
 *
 * The context deliberately carries the RAW, zod-parsed `EntityDefinition`
 * rather than the analyzer's `ParsedEntity`: `ParsedRelationship` drops the
 * relationship's `nullable:`, and `ParsedField` collapses "undeclared" into
 * `false`, so the `optional:` precedence in `build-graph.ts` cannot be
 * reproduced from the parsed model. Naming still comes from the cross-entity
 * registry — the target entity's own `plural`, never a re-pluralized string.
 */

import type { EntityRegistryEntry } from '../../parser/entity-registry';
import type { EntityDefinition } from '../../schema/entity-definition.schema';
import type { JunctionDefinition } from '../../schema/junction-definition.schema';

export type { EntityRegistryEntry } from '../../parser/entity-registry';

/**
 * One table's declared scope posture, as the manifest carries it (REL-2 §3).
 *
 * Structurally the runtime's `ScopeConfig` — the emitter cannot import it (the
 * generator does not depend on the shipped runtime's module graph), and the
 * smoke's `tsc` over the generated project is what pins the two together: the
 * emitted constant is annotated `ScopeConfig`, so a drift is a build error in
 * every consumer project rather than a silent mismatch here.
 */
export interface ScopeConfigLiteral {
	tenantScoped: boolean;
	softDelete: boolean;
	userTracking: boolean;
	enforcement: 'lenient' | 'strict';
}

/** Nothing declared ⇒ no `where` is emitted for a hop into this table. */
export function isUnscopedConfig(cfg: ScopeConfigLiteral): boolean {
	return !cfg.tenantScoped && !cfg.softDelete && !cfg.userTracking;
}

/** One end of a relation, as a reference into the relations builder. */
export interface ColumnRef {
	/** Table identifier as exported from the generated schema barrel. */
	table: string;
	/** Drizzle column property name (camelCase). */
	column: string;
	/** Many-to-many hop: the junction column this end joins through. */
	through?: { table: string; column: string };
}

/**
 * One relation, as it will appear under `<sourceTable>.<key>` in the manifest.
 * `from`/`to` are ALWAYS populated — that is what makes `alias` unnecessary
 * (see docs/specs/REL-1.md R2): Drizzle only consults `alias` when a relation
 * omits them and its columns must be inferred from the reverse side.
 */
export interface RelationEdge {
	sourceTable: string;
	key: string;
	cardinality: 'one' | 'many';
	targetTable: string;
	from: ColumnRef;
	to: ColumnRef;
	/** `one()` only — drives the include's result nullability. */
	optional?: boolean;
	/**
	 * The TARGET entity's declared scope, or `null` when the target declares no
	 * scope at all (a junction table, or a plain entity with no behaviors).
	 *
	 * This is what makes a traversal scoped by CONSTRUCTION: `relationToSQL`
	 * applies a relation's `where` to the target table, so the predicate travels
	 * with the relation and every consumer of it carries it — the `with:` lateral,
	 * the `where: { <relation>: … }` EXISTS form that an include-tree rewriter
	 * cannot see (REL-2 §1.4), and a hand-written `db.query.*` that never touches
	 * a repository.
	 *
	 * `null` keeps the manifest byte-identical to REL-1's output for a graph that
	 * declares no scope anywhere.
	 */
	targetScope: ScopeConfigLiteral | null;
	/** Human-readable declaration site, used in collision messages. */
	origin: string;
}

/**
 * Whole-set emit context. `entities` is the registry set in deterministic
 * (name-sorted) order; `definitions` is keyed by entity name; `junctions` is
 * sorted by derived junction name. Builders never re-sort.
 */
export interface RelationsEmitContext {
	entities: EntityRegistryEntry[];
	definitions: Map<string, EntityDefinition>;
	junctions: JunctionDefinition[];
	/**
	 * Import specifier for the runtime's `scope-filters` module, resolved for the
	 * project's runtime mode (ADR-037). The manifest imports `hopScope` from it —
	 * the one cost of putting the per-hop predicate in the manifest (REL-2 §1.5):
	 * the file stops being a pure description of the graph. It is the same import
	 * the generated repositories already carry.
	 *
	 * Omitted ⇒ `@shared/base-classes/scope-filters` (the vendored form), which is
	 * what the emitter's own tests and `project init` use.
	 */
	scopeFiltersImport?: string;
}

/** Canonical entity order for deterministic emission: ascending by `name`. */
export function sortEntities(entities: EntityRegistryEntry[]): EntityRegistryEntry[] {
	return [...entities].sort((a, b) => a.name.localeCompare(b.name));
}

/** snake_case / kebab-case → camelCase. Local by design (frontend emitter precedent). */
export function camelCase(input: string): string {
	return input.replace(/[-_\s]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Raised when two relations would claim the same key on the same table.
 * The manifest is load-bearing for compilation (the emitted `database.module.ts`
 * imports it), so a collision fails the command rather than warning — a silently
 * dropped edge is exactly the quiet gate charter I9 forbids.
 */
export class RelationKeyCollisionError extends Error {
	constructor(
		readonly table: string,
		readonly key: string,
		readonly first: string,
		readonly second: string,
	) {
		super(
			`relation key collision on table '${table}': '${key}' is declared by ${first} and by ${second}. ` +
				`Rename one of them — a Drizzle relations manifest cannot carry two relations under one key.`,
		);
		this.name = 'RelationKeyCollisionError';
	}
}
