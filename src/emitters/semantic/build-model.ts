/**
 * Semantic emitter — the model builder (SEM-2, ADR-045).
 *
 * The ONLY place semantic-model mapping lives. Turns the parsed entity set plus
 * the junction definitions into a fully-resolved, ordered {@link SemanticModel}.
 * Pure: no fs, no rendering, deterministic for a given context.
 *
 * Everything here is DECLARED — derived from the YAML. Nothing walks Drizzle's
 * relations, the emitted schema files, or the database to recover structure
 * (charter I1). The only Drizzle object the emitted code touches is
 * `getColumns(table)`, and only to obtain `PgColumn` references, which cannot
 * be written down in YAML.
 */

import pluralize from 'pluralize';

import type { ParsedEntity, ParsedField } from '../../analyzer/types';
import type { JunctionDefinition } from '../../schema/junction-definition.schema';
import type {
	AggColType,
	DerivedExprNode,
	SemanticEmitContext,
	SemanticEntity,
	SemanticField,
	SemanticMetric,
	SemanticModel,
	SemanticRelationship,
} from './types';

/**
 * YAML field type → the consuming package's `AggColType`.
 *
 * `string_array` and `entity_ref` are deliberately absent: neither has an
 * `AggColType`, and `entity_ref` emits TWO columns from one YAML field
 * (`<field>EntityType` + `<field>EntityId`). Inventing a type would make the
 * package resolve a column it cannot compile. They stay real columns in
 * `registry.columns`; they are simply not analytically addressable.
 */
const AGG_COL_TYPE: Record<string, AggColType> = {
	string: 'string',
	integer: 'number',
	decimal: 'number',
	boolean: 'boolean',
	uuid: 'uuid',
	date: 'datetime',
	datetime: 'datetime',
	json: 'json',
	enum: 'enum',
};

/**
 * Columns that carry tenancy or ownership. Always dimensions, never measures.
 *
 * "Never a measure" holds by construction — a measure is only ever a field the
 * YAML tags `role: measure` — but the explicit dimension role is what makes
 * them group-able without the author restating it on every entity.
 */
const SCOPE_COLUMNS = new Set(['tenant_id', 'organization_id', 'user_id']);

/**
 * A junction payload field's YAML `type:` → `AggColType`, mirroring what
 * `templates/junction/new/prompt.js` (`DRIZZLE_TYPE_MAP`) turns it into: an
 * enum only when `choices:` is non-empty (otherwise a `text` column), and any
 * type the template does not map becomes `text` too.
 */
function junctionFieldType(field: { type?: string; choices?: unknown }): AggColType {
	const hasChoices = Array.isArray(field.choices) && field.choices.length > 0;
	if (hasChoices) return 'enum';
	const type = field.type ?? 'string';
	if (type === 'enum') return 'string';
	return AGG_COL_TYPE[type] ?? 'string';
}

/**
 * Every column a junction table actually has, as `analytics.fields` — the
 * exact set `templates/junction/new/entity.ejs.t` emits:
 *
 * - the two FK columns;
 * - `role`, when `fields.role.choices` is non-empty (a pg enum that is part of
 *   the composite key) — derived to a dimension with a declared domain, the
 *   same way scope columns are derived: it is the junction's identity, so
 *   grouping by it needs no tag;
 * - the BaseJunctionFields: `is_primary` always, `started_at` / `ended_at`
 *   when `temporal` (default true), `sourced_from` / `confidence` /
 *   `matched_at` when `sourced` (default true);
 * - every other `fields:` entry, typed as the template types it;
 * - `created_at` / `updated_at`.
 *
 * There is no `id`: a junction's key is composite (see `compositeKey`). A
 * `role` declared with anything but a non-empty `choices:` produces no column
 * at all (the template drops it), so it is not emitted either. Junction YAML
 * has no analytics tag vocabulary, so nothing here is a measure.
 */
function buildJunctionFields(def: JunctionDefinition): {
	fields: Record<string, SemanticField>;
	compositeKey: string[];
} {
	const [left, right] = def.between;
	const payload = (def.fields ?? {}) as Record<string, { type?: string; choices?: unknown }>;
	const fields: Record<string, SemanticField> = {};
	const put = (key: string, type: AggColType, extra: Partial<SemanticField> = {}) => {
		fields[key] = { key, type, column: key, ...extra };
	};

	put(`${left}_id`, 'uuid');
	put(`${right}_id`, 'uuid');
	const compositeKey = [`${left}_id`, `${right}_id`];

	const role = payload.role;
	if (role && Array.isArray(role.choices) && role.choices.length > 0) {
		put('role', 'enum', { role: 'dimension', hasDeclaredDomain: true });
		compositeKey.push('role');
	}

	put('is_primary', 'boolean');
	if (def.temporal !== false) {
		put('started_at', 'datetime');
		put('ended_at', 'datetime');
	}
	if (def.sourced !== false) {
		put('sourced_from', 'string');
		put('confidence', 'number');
		put('matched_at', 'datetime');
	}

	for (const [name, field] of Object.entries(payload)) {
		if (name === 'role') continue;
		const type = junctionFieldType(field ?? {});
		put(name, type, type === 'enum' ? { hasDeclaredDomain: true } : {});
	}

	put('created_at', 'datetime');
	put('updated_at', 'datetime');

	return { fields, compositeKey };
}

/** Identifier columns that are never worth full-text matching. */
const NEVER_SEARCHABLE = new Set(['id', 'external_id']);

/** snake_case → camelCase, matching the template helpers. */
function camelCase(value: string): string {
	return value.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Junction identity: the pairing is the only source (`JunctionDefinitionSchema`
 * is `.strict()` and declares no `name`).
 *
 * `tableVar` is CAMEL-CASED, unlike an entity's. The two templates disagree and
 * the model has to match what the schema barrel actually exports:
 * `templates/entity/new/clean-lite-ps/entity.ejs.t` emits
 * `export const <plural> = pgTable(…)` verbatim (`deal_states`), while
 * `templates/junction/new/entity.ejs.t` emits `export const <tableVarName>`
 * where `tableVarName = camelCase(plural)` (`opportunityContacts`). Getting
 * this wrong emits `schema.opportunity_contacts`, which does not exist.
 *
 * NOTE: this derivation also exists in `src/cli/shared/barrel-generator.ts` and
 * in REL-1's relations emitter. The three cannot be folded together yet —
 * REL-1 (#614) and SEM-2 are sibling PRs on one base, neither in the other's
 * tree. Consolidating is a follow-up for after both land.
 */
export function junctionIdentity(def: JunctionDefinition): {
	name: string;
	plural: string;
	table: string;
	tableVar: string;
} {
	const name = `${def.between[0]}_${def.between[1]}`;
	const plural = pluralize(name);
	return { name, plural, table: plural, tableVar: camelCase(plural) };
}

/** Is this field's column a `belongs_to` foreign key on its own entity? */
function foreignKeyColumns(entity: ParsedEntity): Set<string> {
	const fks = new Set<string>();
	for (const rel of entity.relationships.values()) {
		if (rel.type === 'belongs_to' && rel.foreignKey) fks.add(rel.foreignKey);
	}
	return fks;
}

/**
 * `searchableColumns` — the consuming package's rule, applied to the
 * DECLARATION rather than to introspected Drizzle columns: string-typed
 * columns that are not identifiers, foreign keys or enums.
 *
 * Deriving from YAML is not just the I1-correct reading, it is the only stable
 * one. The package's introspection form keys off `col.dataType === 'string'`,
 * and Drizzle 1.0 changed `dataType` to a compound string (`'string uuid'`,
 * `'string enum'`, `'object date'`), which silently moves that boundary
 * (docs/specs/SEM-2.md S3).
 */
function deriveSearchableColumns(entity: ParsedEntity): string[] {
	const fks = foreignKeyColumns(entity);
	const out: string[] = [];
	for (const [name, field] of entity.fields) {
		if (field.type !== 'string') continue;
		if (NEVER_SEARCHABLE.has(name)) continue;
		if (name.endsWith('_id')) continue;
		if (fks.has(name)) continue;
		out.push(name);
	}
	return out.sort();
}

/** One field's `AggFieldMeta`, or null when the type has no analytics mapping. */
function buildField(name: string, field: ParsedField): SemanticField | null {
	const type = AGG_COL_TYPE[field.type];
	if (type === undefined) return null;

	const tags = field.analytics;
	const out: SemanticField = { key: name, type, column: name };

	if (tags.role !== undefined) out.role = tags.role;
	else if (SCOPE_COLUMNS.has(name)) out.role = 'dimension';

	if (tags.agg !== undefined) out.agg = tags.agg;
	if (tags.aggs !== undefined) out.aggs = [...tags.aggs];
	if (tags.additivity !== undefined) out.additivity = tags.additivity;
	if (tags.time !== undefined) out.time = tags.time;

	// A dimension whose value domain is enumerated in the declaration — inline
	// (`choices:`) or in a referenced file (`choices_from:`). The package
	// surfaces this as `valueDomain: 'declared'` so an agent knows the values are
	// already known without a probe query.
	if (field.type === 'enum' && ((field.choices?.length ?? 0) > 0 || field.choicesFrom !== undefined)) {
		out.hasDeclaredDomain = true;
	}

	return out;
}

/**
 * Declared relationships for one entity.
 *
 * `through:` (transitive) relationships are NOT emitted: the package resolves
 * multi-hop paths itself from the one-hop graph, and synthesising an edge here
 * would invent a join the YAML never declared.
 */
function buildRelationships(
	entity: ParsedEntity,
	known: ReadonlySet<string>,
	warnings: string[],
): Record<string, SemanticRelationship> {
	const out: Record<string, SemanticRelationship> = {};
	const names = [...entity.relationships.keys()].sort();

	for (const relName of names) {
		const rel = entity.relationships.get(relName)!;
		if (rel.through) continue;
		if (!known.has(rel.target)) {
			warnings.push(
				`${entity.name}.${relName}: target '${rel.target}' is not a declared entity — relationship omitted`,
			);
			continue;
		}
		out[relName] = { kind: rel.type, target: rel.target, fk: rel.foreignKey };
	}
	return out;
}

/** Sort an object's keys so emitted output never depends on insertion order. */
function sortedRecord<T>(input: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(input).sort()) out[key] = input[key]!;
	return out;
}

/** Entity-level `analytics.metrics:` → catalog composites, sorted by name. */
function buildMetrics(context: SemanticEmitContext): SemanticMetric[] {
	const metrics: SemanticMetric[] = [];
	for (const entry of context.entities) {
		const parsed = context.parsed.get(entry.name);
		const declared = parsed?.analytics?.metrics;
		if (!declared) continue;
		for (const name of Object.keys(declared).sort()) {
			const metric = declared[name]!;
			switch (metric.type) {
				case 'ratio':
					metrics.push({
						name,
						kind: 'ratio',
						numerator: metric.numerator,
						denominator: metric.denominator,
						...(metric.label !== undefined ? { label: metric.label } : {}),
					});
					break;
				case 'derived':
					metrics.push({
						name,
						kind: 'derived',
						expr: metric.expr as DerivedExprNode,
						...(metric.label !== undefined ? { label: metric.label } : {}),
					});
					break;
				case 'cumulative':
					metrics.push({
						name,
						kind: 'cumulative',
						measure: metric.measure,
						order_by: metric.order_by,
						...(metric.partition_by !== undefined
							? { partition_by: metric.partition_by }
							: {}),
						...(metric.label !== undefined ? { label: metric.label } : {}),
					});
					break;
			}
		}
	}
	return metrics.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the whole model.
 *
 * Atomic catalog entries are NOT produced here: the consuming package derives
 * them from the `role: measure` field tags (`measuresFromRegistry`). Emitting
 * them too would be a second declaration of one rule and would trip the
 * package's own ambiguity check (SEM-1, docs/specs/SEM-1.md §What downstream
 * must know).
 */
export function buildSemanticModel(context: SemanticEmitContext): SemanticModel {
	const warnings: string[] = [];
	const known = new Set(context.entities.map((e) => e.name));
	const entities: SemanticEntity[] = [];

	// --- declared entities ---------------------------------------------------
	for (const entry of context.entities) {
		const parsed = context.parsed.get(entry.name);
		if (!parsed) {
			warnings.push(`${entry.name}: registry entry has no parsed definition — skipped`);
			continue;
		}

		const fields: Record<string, SemanticField> = {};
		for (const [name, field] of parsed.fields) {
			const built = buildField(name, field);
			if (built) fields[name] = built;
		}

		entities.push({
			name: entry.name,
			tableVar: entry.plural,
			tableName: parsed.table,
			primaryKey: 'id',
			relationships: buildRelationships(parsed, known, warnings),
			fields: sortedRecord(fields),
			searchableColumns: deriveSearchableColumns(parsed),
			kind: 'entity',
		});
	}

	// --- junctions -----------------------------------------------------------
	// A junction gets its own registry entry (`meta.kind: 'junction'`) with two
	// belongs_to descriptors, and contributes an inverse has_many to each
	// endpoint so the graph is walkable in both directions.
	const byName = new Map(entities.map((e) => [e.name, e]));

	for (const def of context.junctions) {
		const identity = junctionIdentity(def);
		const [left, right] = def.between;

		const missing = [left, right].filter((endpoint) => !byName.has(endpoint));
		if (missing.length > 0) {
			warnings.push(
				`junction ${identity.name}: endpoint(s) ${missing.join(', ')} are not declared entities — junction omitted`,
			);
			continue;
		}

		const relationships: Record<string, SemanticRelationship> = {
			[left]: { kind: 'belongs_to', target: left, fk: `${left}_id` },
			[right]: { kind: 'belongs_to', target: right, fk: `${right}_id` },
		};

		const { fields, compositeKey } = buildJunctionFields(def);

		entities.push({
			name: identity.name,
			tableVar: identity.tableVar,
			tableName: identity.table,
			primaryKey: 'id',
			relationships: sortedRecord(relationships),
			fields: sortedRecord(fields),
			searchableColumns: [],
			kind: 'junction',
			compositeKey,
		});

		// Inverse edges on the endpoints, keyed by the junction's plural.
		for (const endpoint of [left, right]) {
			const target = byName.get(endpoint)!;
			target.relationships = sortedRecord({
				...target.relationships,
				[identity.plural]: {
					kind: 'has_many',
					target: identity.name,
					fk: `${endpoint}_id`,
				},
			});
		}
	}

	entities.sort((a, b) => a.name.localeCompare(b.name));

	return { entities, metrics: buildMetrics(context), warnings };
}
