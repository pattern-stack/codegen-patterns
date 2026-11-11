/**
 * Relations emitter — YAML → relation edges (ADR-044, REL-1).
 *
 * The ONLY place relationship semantics live for the manifest. Everything here
 * derives from a declaration in the entity YAML (`relationships:`) or a junction
 * YAML (`between:`) — nothing is recovered by introspecting Drizzle, the emitted
 * schema files, or the database (charter I1).
 */

import { resolveImpliedBehaviors } from '../../patterns/implied-behaviors.js';
import pluralize from 'pluralize';

import type { EntityDefinition } from '../../schema/entity-definition.schema';
import type { JunctionDefinition } from '../../schema/junction-definition.schema';
import { foreignKeyColumnNullable } from '../../schema/field-nullability';
import { resolveTenancy } from '../../schema/tenancy';
import {
	camelCase,
	RelationKeyCollisionError,
	type ColumnRef,
	type EntityRegistryEntry,
	type RelationEdge,
	type RelationsEmitContext,
	type ScopeConfigLiteral,
} from './types';

export interface RelationGraph {
	/** Edges grouped by source table, both levels in deterministic order. */
	tables: Array<{ table: string; edges: RelationEdge[] }>;
	/** Non-fatal problems (an unresolvable target, a junction endpoint with no YAML). */
	warnings: string[];
	/**
	 * Every ENTITY table's declared scope (`null` = declares none), table-sorted —
	 * not only hop targets: a table nothing points at still has a root, and a read
	 * outside a repository needs its scope (READ-1 §5, #843). Junction tables are
	 * not here; they declare no scope (REL-2 §1.5).
	 */
	entityScopes: Array<{ table: string; scope: ScopeConfigLiteral | null }>;
}

/**
 * Junction identity, derived exactly as `templates/junction/new/prompt.js` does
 * (`deriveJunctionName` / `deriveTableName`, `:81-84`, `:236-240`): the pairing
 * IS the name (`JunctionDefinitionSchema` is `.strict()` and declares no `name`
 * or `table` key), the table is its plural, and the exported const is that
 * plural camelCased.
 */
export function junctionIdentity(def: JunctionDefinition): {
	name: string;
	plural: string;
	tableVar: string;
} {
	const name = `${def.between[0]}_${def.between[1]}`;
	const plural = pluralize(name);
	return { name, plural, tableVar: camelCase(plural) };
}

/** `account_id` → `accountId`; the junction FK column property for an endpoint. */
function junctionFkColumn(entityName: string): string {
	return camelCase(`${entityName}_id`);
}

/**
 * The behaviors an entity HAS: those it declares, in either YAML form, plus those
 * its pattern(s) imply (ADR-031) — through `resolveImpliedBehaviors`, the same
 * helper the repository's `behaviors` come from (`entity-locals.js`). Reading
 * only the declared ones would let a pattern that implies `soft_delete` filter
 * deleted rows in the repository while every hop, `SCOPES` and `scopedRoot` did
 * not: one declaration, two postures (charter I1; READ-1 review #9).
 */
function behaviorNames(def: EntityDefinition): Set<string> {
	return new Set([
		...def.behaviors.map((b) => (typeof b === 'string' ? b : b.name)),
		...resolveImpliedBehaviors(def.entity),
	]);
}

/**
 * One entity's declared scope posture (REL-2 §3.1).
 *
 * Every field is read from the entity's own YAML — the `tenant_scoped:` flag and
 * the `soft_delete` / `user_tracking` behaviors — plus the project's default
 * tenant column, resolved by the same rule the entity template uses
 * (`resolveTenancy`, #791), so a hop filters on the column the table has. Nothing is recovered by looking
 * at the emitted table's columns: that would be re-deriving what the declaration
 * already says, which is the I1 violation this project exists to remove (and the
 * exact thing TEN-1 §8 asks REL-2 not to do).
 *
 * `enforcement` follows TEN-1 §3.4: a tenant-scoped entity is `strict`, so a
 * traversal into it with no ambient boundary throws at query BUILD rather than
 * reading the union of every tenant. A `user_tracking`-only entity stays
 * `lenient`, which is the posture it has today.
 *
 * Returns `null` when nothing is declared, so the manifest for an unscoped graph
 * is byte-identical to REL-1's.
 */
export function entityScope(
	def: EntityDefinition,
	tenancyColumn: string,
): ScopeConfigLiteral | null {
	const names = behaviorNames(def);
	const tenancy = resolveTenancy(def.entity.name, def, tenancyColumn);
	const cfg: ScopeConfigLiteral = {
		tenantScoped: tenancy !== null,
		...(tenancy ? { tenantColumn: tenancy.prop } : {}),
		softDelete: names.has('soft_delete'),
		userTracking: names.has('user_tracking'),
		enforcement: tenancy !== null ? 'strict' : 'lenient',
	};
	if (!cfg.tenantScoped && !cfg.softDelete && !cfg.userTracking) return null;
	return cfg;
}

/**
 * Whether a hop's `where` can drop a row the FK points at — so a to-one
 * include can be `null` even over a NOT NULL FK.
 *
 * `softDelete` (the target row is deleted) and `userTracking` (it belongs to
 * another user) are ordinary states of valid data, so either one counts.
 *
 * The tenant axis counts only when the SOURCE is not tenant-scoped. A
 * tenant-scoped source row and its target are read under the same tenant, so
 * a NOT NULL FK onto another tenant's row is a data error, not a case for the
 * type to carry (#787 designs the constraint that makes it impossible), and
 * widening every tenant-scoped to-one would push a null check onto every
 * reader of valid data. An unscoped source (a global table, or a junction —
 * which declares no scope of its own) reads every tenant's rows, so the hop
 * drops each one whose target is outside the requester's tenant: valid data,
 * read as `null`.
 */
export function hopCanDropTarget(
	sourceScope: ScopeConfigLiteral | null,
	targetScope: ScopeConfigLiteral | null,
): boolean {
	if (targetScope === null) return false;
	if (targetScope.softDelete || targetScope.userTracking) return true;
	return targetScope.tenantScoped && !(sourceScope?.tenantScoped ?? false);
}

/**
 * `optional` for a `belongs_to` — whether the include's result may be null.
 *
 * The FK column's nullability, by the one rule the entity template emits the
 * column with (`foreignKeyColumnNullable`, `field-nullability.ts`): an explicit
 * relationship `nullable:` wins, else the FK field's own `nullable:`, else NOT
 * NULL — not optional (#613, #850). A NOT NULL FK is still optional when the
 * hop's scope can filter its target out (`hopCanDropTarget`) — REL-2's hop
 * `where` makes the include `null` at runtime, and the type must say so
 * (#850).
 */
function belongsToOptional(
	def: EntityDefinition,
	fk: string,
	relNullable: boolean | undefined,
	sourceScope: ScopeConfigLiteral | null,
	targetScope: ScopeConfigLiteral | null,
): boolean {
	return (
		foreignKeyColumnNullable(relNullable, def.fields[fk]) ||
		hopCanDropTarget(sourceScope, targetScope)
	);
}

/** Add an edge, failing loudly on a duplicate key for the same table. */
function push(
	byTable: Map<string, Map<string, RelationEdge>>,
	edge: RelationEdge,
): void {
	let table = byTable.get(edge.sourceTable);
	if (!table) {
		table = new Map();
		byTable.set(edge.sourceTable, table);
	}
	const existing = table.get(edge.key);
	if (existing) {
		throw new RelationKeyCollisionError(
			edge.sourceTable,
			edge.key,
			existing.origin,
			edge.origin,
		);
	}
	table.set(edge.key, edge);
}

/**
 * Build the whole relation graph from the emit context.
 *
 * Throws {@link RelationKeyCollisionError} when two declarations claim the same
 * key on one table. Everything else that cannot be resolved (a `target:` with no
 * YAML, a junction endpoint with no YAML) is skipped with a warning — those
 * entities have no table in the schema barrel either, so an edge to them could
 * not compile.
 */
export function buildRelationGraph(ctx: RelationsEmitContext): RelationGraph {
	const byTable = new Map<string, Map<string, RelationEdge>>();
	const warnings: string[] = [];

	const registry = new Map<string, EntityRegistryEntry>(
		ctx.entities.map((e) => [e.name, e]),
	);

	// Every edge carries its TARGET's declared scope, because `relationToSQL`
	// applies a relation's `where` to the target table (REL-2 §1.6). Resolved once
	// here, from the target's own YAML — the same registry-first rule naming uses.
	const scopeOf = (entityName: string): ScopeConfigLiteral | null => {
		const def = ctx.definitions.get(entityName);
		return def ? entityScope(def, ctx.tenancyColumn) : null;
	};

	// ── declared `relationships:` ────────────────────────────────────────────
	for (const entity of ctx.entities) {
		const def = ctx.definitions.get(entity.name);
		if (!def?.relationships) continue;

		for (const [relName, rel] of Object.entries(def.relationships)) {
			const origin = `${entity.name}.relationships.${relName}`;

			// A transitive relationship (`through: 'owned_opportunities.updates'`)
			// is a PATH, not an edge: its `foreign_key` lives on the far end of the
			// path, not on a table adjacent to this one. Emitting it as a direct
			// edge `source.id → target.<foreign_key>` would join the wrong columns
			// and return wrong rows. Skipped until REL-2 decides real support
			// (docs/specs/REL-1.md §2).
			if (rel.through) {
				warnings.push(
					`${origin}: transitive relationship (through '${rel.through}') is not a direct edge — ` +
						`relation skipped (traversal through a path is REL-2's to design)`,
				);
				continue;
			}

			const target = registry.get(rel.target);
			if (!target) {
				warnings.push(
					`${origin}: target entity '${rel.target}' has no YAML in the entity set — relation skipped`,
				);
				continue;
			}

			const key = camelCase(relName);
			const fkColumn = camelCase(rel.foreign_key);

			if (rel.type === 'belongs_to') {
				// FK lives on THIS table.
				push(byTable, {
					sourceTable: entity.plural,
					key,
					cardinality: 'one',
					targetTable: target.plural,
					from: { table: entity.plural, column: fkColumn },
					to: { table: target.plural, column: 'id' },
					optional: belongsToOptional(
						def,
						rel.foreign_key,
						rel.nullable,
						scopeOf(entity.name),
						scopeOf(rel.target),
					),
					targetScope: scopeOf(rel.target),
					origin,
				});
				continue;
			}

			// `has_many` / `has_one`: the declared foreign_key is the inverse FK,
			// living on the TARGET table (processHasMany, prompt-extension.js:391-398).
			push(byTable, {
				sourceTable: entity.plural,
				key,
				cardinality: rel.type === 'has_many' ? 'many' : 'one',
				targetTable: target.plural,
				from: { table: entity.plural, column: 'id' },
				to: { table: target.plural, column: fkColumn },
				// An inverse `has_one` row may simply not exist.
				...(rel.type === 'has_one' ? { optional: true } : {}),
				targetScope: scopeOf(rel.target),
				origin,
			});
		}
	}

	// ── junctions: the many-to-many hop plus the junction's own two edges ────
	//
	// `expose_on_parent` is NOT consulted here: it governs the parent SERVICE's
	// fan-out methods (CGP-60), not the graph. Internal navigability defaults to
	// every declared relationship (PLAN §5A.6); HTTP exposure is REL-2's
	// allowlist.
	for (const junction of ctx.junctions) {
		const { name, plural, tableVar } = junctionIdentity(junction);
		const origin = `junction ${name}`;
		const [leftName, rightName] = junction.between;
		const left = registry.get(leftName);
		const right = registry.get(rightName);
		if (!left || !right) {
			const missing = [!left ? leftName : null, !right ? rightName : null]
				.filter(Boolean)
				.join(', ');
			warnings.push(
				`${origin}: endpoint entit${missing.includes(',') ? 'ies' : 'y'} '${missing}' ` +
					`ha${missing.includes(',') ? 've' : 's'} no YAML in the entity set — junction relations skipped`,
			);
			continue;
		}

		const leftFk = junctionFkColumn(leftName);
		const rightFk = junctionFkColumn(rightName);
		const through = (column: string): ColumnRef['through'] => ({
			table: tableVar,
			column,
		});

		// A ↔ B, through the junction.
		push(byTable, {
			sourceTable: left.plural,
			key: camelCase(right.plural),
			cardinality: 'many',
			targetTable: right.plural,
			from: { table: left.plural, column: 'id', through: through(leftFk) },
			to: { table: right.plural, column: 'id', through: through(rightFk) },
			targetScope: scopeOf(rightName),
			origin,
		});
		push(byTable, {
			sourceTable: right.plural,
			key: camelCase(left.plural),
			cardinality: 'many',
			targetTable: left.plural,
			from: { table: right.plural, column: 'id', through: through(rightFk) },
			to: { table: left.plural, column: 'id', through: through(leftFk) },
			targetScope: scopeOf(leftName),
			origin,
		});

		// Each parent to the junction ROWS themselves — that is where the
		// junction's own columns (role, temporal window, provenance) live.
		push(byTable, {
			sourceTable: left.plural,
			key: camelCase(plural),
			cardinality: 'many',
			targetTable: tableVar,
			from: { table: left.plural, column: 'id' },
			to: { table: tableVar, column: leftFk },
			// A junction table declares no scope of its own — `JunctionDefinitionSchema`
			// is `.strict()` and has no scoping flag, so it has no `tenant_id` and no
			// `deleted_at`. REL-2 §1.5 measures what that means (a foreign junction row
			// can fabricate an EDGE between two of the reader's rows, never leak a row)
			// and pins it with a characterisation test.
			targetScope: null,
			origin,
		});
		push(byTable, {
			sourceTable: right.plural,
			key: camelCase(plural),
			cardinality: 'many',
			targetTable: tableVar,
			from: { table: right.plural, column: 'id' },
			to: { table: tableVar, column: rightFk },
			targetScope: null,
			origin,
		});

		// The junction's own belongs_to edges.
		push(byTable, {
			sourceTable: tableVar,
			key: camelCase(leftName),
			cardinality: 'one',
			targetTable: left.plural,
			from: { table: tableVar, column: leftFk },
			to: { table: left.plural, column: 'id' },
			// The junction FK is NOT NULL; only the target's scope can empty the hop.
			// A junction declares no scope (source `null`), so a tenant-scoped
			// endpoint counts too.
			optional: hopCanDropTarget(null, scopeOf(leftName)),
			targetScope: scopeOf(leftName),
			origin,
		});
		push(byTable, {
			sourceTable: tableVar,
			key: camelCase(rightName),
			cardinality: 'one',
			targetTable: right.plural,
			from: { table: tableVar, column: rightFk },
			to: { table: right.plural, column: 'id' },
			// The junction FK is NOT NULL; only the target's scope can empty the hop.
			optional: hopCanDropTarget(null, scopeOf(rightName)),
			targetScope: scopeOf(rightName),
			origin,
		});
	}

	// CAP-2 seam (ADR-041 `roles:`): a role is one more edge from the source
	// table to the actor table — append it to this map the same way the blocks
	// above do. No `alias` is needed for it either: every edge emitted here
	// carries explicit `from`/`to`, which is the only reason Drizzle would ever
	// consult one (docs/specs/REL-1.md R2).

	const tables = [...byTable.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([table, edges]) => ({
			table,
			edges: [...edges.values()].sort((a, b) => a.key.localeCompare(b.key)),
		}));

	const entityScopes = ctx.entities
		.map((e) => ({ table: e.plural, scope: scopeOf(e.name) }))
		.sort((a, b) => a.table.localeCompare(b.table));

	return { tables, warnings, entityScopes };
}
