/**
 * Relations emitter — YAML → relation edges (ADR-044, REL-1).
 *
 * The ONLY place relationship semantics live for the manifest. Everything here
 * derives from a declaration in the entity YAML (`relationships:`) or a junction
 * YAML (`between:`) — nothing is recovered by introspecting Drizzle, the emitted
 * schema files, or the database (charter I1).
 */

import pluralize from 'pluralize';

import type { EntityDefinition } from '../../schema/entity-definition.schema';
import type { JunctionDefinition } from '../../schema/junction-definition.schema';
import {
	camelCase,
	RelationKeyCollisionError,
	type ColumnRef,
	type EntityRegistryEntry,
	type RelationEdge,
	type RelationsEmitContext,
} from './types';

export interface RelationGraph {
	/** Edges grouped by source table, both levels in deterministic order. */
	tables: Array<{ table: string; edges: RelationEdge[] }>;
	/** Non-fatal problems (an unresolvable target, a junction endpoint with no YAML). */
	warnings: string[];
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
 * `optional` for a `belongs_to` — whether the include's result may be null.
 *
 * Precedence, on the same YAML `processBelongsTo` reads
 * (`templates/entity/new/clean-lite-ps/prompt-extension.js:468-482`): an
 * explicit relationship `nullable:` wins, else the FK column's own `fields:`
 * declaration — `required: true` ⇒ NOT NULL ⇒ not optional, `nullable: true` ⇒
 * optional — else optional.
 *
 * One deliberate divergence from the template, forced by the schema rather than
 * chosen: `FieldDefinitionSchema` defaults BOTH `required` and `nullable` to
 * `false` (`entity-definition.schema.ts:172-173`), so after parsing, a field
 * that declared neither is indistinguishable from one that declared
 * `nullable: false`. The template sees the raw YAML and treats "declared
 * neither" as nullable. This function therefore keys off `required` alone, which
 * matches the template for every declaration except `{ required: false,
 * nullable: false }` — there the column is NOT NULL but the include's type stays
 * `T | null`. Over-permissive, never a wrong row. The underlying default is a
 * pre-existing inconsistency between the TS and hygen halves of the generator
 * (`ParsedField` collapses the same way) and is filed as #613, not
 * papered over here.
 */
function belongsToOptional(
	def: EntityDefinition,
	fk: string,
	relNullable: boolean | undefined,
): boolean {
	if (relNullable !== undefined && relNullable !== null) return relNullable;
	const field = def.fields[fk];
	if (!field) return true;
	if (field.nullable === true) return true;
	return field.required !== true;
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

	// ── declared `relationships:` ────────────────────────────────────────────
	for (const entity of ctx.entities) {
		const def = ctx.definitions.get(entity.name);
		if (!def?.relationships) continue;

		for (const [relName, rel] of Object.entries(def.relationships)) {
			const origin = `${entity.name}.relationships.${relName}`;
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
					optional: belongsToOptional(def, rel.foreign_key, rel.nullable),
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
			origin,
		});
		push(byTable, {
			sourceTable: right.plural,
			key: camelCase(left.plural),
			cardinality: 'many',
			targetTable: left.plural,
			from: { table: right.plural, column: 'id', through: through(rightFk) },
			to: { table: left.plural, column: 'id', through: through(leftFk) },
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
			origin,
		});
		push(byTable, {
			sourceTable: right.plural,
			key: camelCase(plural),
			cardinality: 'many',
			targetTable: tableVar,
			from: { table: right.plural, column: 'id' },
			to: { table: tableVar, column: rightFk },
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
			optional: false,
			origin,
		});
		push(byTable, {
			sourceTable: tableVar,
			key: camelCase(rightName),
			cardinality: 'one',
			targetTable: right.plural,
			from: { table: tableVar, column: rightFk },
			to: { table: right.plural, column: 'id' },
			optional: false,
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

	return { tables, warnings };
}
