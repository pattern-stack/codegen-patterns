/**
 * Joined-table inheritance cross-validator (RFC-0006, #875)
 *
 * Runs over the whole entity set because every rule here reads two YAML files:
 * a child against its base, a `match:` against its target, a `choices_of:`
 * against its owner. The rules that read one file live in
 * `src/schema/inheritance.ts` (a Zod refinement), and this module reads the
 * same declaration helpers, so a message reads the same wherever it comes from.
 *
 *   R1  a base's discriminator, and `choices_of:`'s target (no chains)
 *   R2  each choice has at most one child; `as:` is one of the base's choices
 *   R3  one level: a base may not itself inherit
 *   R4  no name is declared on both a child and its base
 *   R6  a child's pattern config names only its own columns
 *   R7  a child's `queries:` name only its own columns
 *   R8  base and children share one `entity.sync`
 *   R10 a `tenant_scoped` base declares its tenant column NOT NULL
 *   M1–M5  `match:` (composite FK) targets, local columns and types
 *
 * Pure and framework-agnostic, like `validate-emits.ts` and
 * `validate-semantic.ts`: it never throws and returns issues; the CLI surfaces
 * them. Every message names the entities (and fields) involved.
 */

import type { AnalysisIssue } from '../analyzer/types.js';
import { getBehavior, normalizeBehaviorConfig } from '../behaviors/index.js';
import { resolveImpliedBehaviors } from '../patterns/implied-behaviors.js';
import type { EntityDefinition } from '../schema/entity-definition.schema.js';
import { columnNotNull, declaresColumn, inheritsOf } from '../schema/inheritance.js';
import {
	DEFAULT_TENANT_COLUMN,
	baseTenantColumnIssue,
	tenantColumnName,
} from '../schema/tenancy.js';

/** One loaded entity: its definition and the file it came from. */
export interface InheritanceEntity {
	definition: EntityDefinition;
	filePath: string;
}

export interface ValidateInheritanceOptions {
	/** The project's `tenancy.column`. Defaults to `tenant_id`. */
	tenancyColumn?: string;
}

/** The resolved match pairs of one relationship: `[local column, target column]`. */
export function matchPairs(match: NonNullable<EntityDefinition['relationships']>[string]['match']): Array<[string, string]> {
	if (match === undefined) return [];
	if (Array.isArray(match)) return match.map((c) => [c, c]);
	return Object.entries(match);
}

type Rel = NonNullable<EntityDefinition['relationships']>[string];

/** The names a table declares on its own: fields, FK columns, relation and role keys, behavior and tenant columns. */
function ownNames(def: EntityDefinition): Map<string, string> {
	const names = new Map<string, string>();
	const add = (n: string, what: string) => {
		if (!names.has(n)) names.set(n, what);
	};
	for (const f of Object.keys(def.fields)) add(f, `field '${f}'`);
	for (const [key, rel] of Object.entries(def.relationships ?? {})) {
		add(key, `relationship '${key}'`);
		if (rel.type === 'belongs_to') add(rel.foreign_key, `foreign key '${rel.foreign_key}' (relationship '${key}')`);
	}
	for (const key of Object.keys(def.roles ?? {})) add(key, `role '${key}'`);
	return names;
}

/** The columns a behavior or the tenant block adds to a table, besides its declared fields. */
function implicitColumns(def: EntityDefinition, tenancyColumn: string): Map<string, string> {
	const cols = new Map<string, string>([['id', "the primary key 'id'"]]);
	const explicit = (def.behaviors ?? []).map((b) => normalizeBehaviorConfig(b).name);
	const implied = resolveImpliedBehaviors(def.entity);
	for (const name of [...new Set([...explicit, ...implied])]) {
		for (const f of getBehavior(name)?.fields ?? []) cols.set(f.name, `the '${f.name}' column of the '${name}' behavior`);
	}
	const tenant = tenantColumnName(def.tenant_scoped, tenancyColumn);
	if (tenant !== null) cols.set(tenant, `the tenant column '${tenant}'`);
	return cols;
}

/** The literal choice list of an enum field, following ONE `choices_of:` hop; `undefined` when unknown. */
function resolveChoices(
	byName: Map<string, InheritanceEntity>,
	def: EntityDefinition,
	field: string,
): string[] | undefined {
	const f = def.fields[field];
	if (f === undefined) return undefined;
	if (f.choices?.length) return f.choices;
	if (f.choices_of !== undefined) {
		const [entity, targetField] = f.choices_of.split('.') as [string, string];
		const target = byName.get(entity)?.definition.fields[targetField];
		return target?.choices?.length ? target.choices : undefined;
	}
	return undefined;
}

/**
 * The SQL type identity of a column for M3 / M5: two columns are comparable
 * when this string is equal. An enum's identity is the entity that owns its
 * `pgEnum` — the field's own entity, or the `choices_of:` owner.
 */
function sqlTypeKey(def: EntityDefinition, column: string): string | undefined {
	for (const rel of Object.values(def.relationships ?? {})) {
		if (rel.type === 'belongs_to' && rel.foreign_key === column && def.fields[column] === undefined) {
			return 'uuid';
		}
	}
	const f = def.fields[column];
	if (f === undefined) return undefined;
	if (f.type === 'enum') {
		return f.choices_of !== undefined ? `enum:${f.choices_of}` : `enum:${def.entity.name}.${column}`;
	}
	return f.type;
}

/** Every string leaf of a value, depth-first. */
function stringLeaves(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value);
	else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
	else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, out);
	return out;
}

/** The column names a `queries:` entry reads. */
function queryColumns(q: NonNullable<EntityDefinition['queries']>[number]): string[] {
	if ('name' in q) return [...q.filters, ...(q.search !== undefined ? [q.search] : [])];
	const order = q.order?.trim().split(/\s+/)[0];
	return [...q.by, ...(q.select ?? []), ...(order ? [order] : [])];
}

/** Cross-validate the whole entity set. Never throws. */
export function validateInheritance(
	entities: InheritanceEntity[],
	options: ValidateInheritanceOptions = {},
): AnalysisIssue[] {
	const tenancyColumn = options.tenancyColumn ?? DEFAULT_TENANT_COLUMN;
	const issues: AnalysisIssue[] = [];
	const byName = new Map<string, InheritanceEntity>();
	for (const e of entities) byName.set(e.definition.entity.name, e);

	const error = (
		entity: InheritanceEntity,
		type: string,
		message: string,
		field?: string,
	): void => {
		issues.push({
			severity: 'error',
			type,
			entity: entity.definition.entity.name,
			...(field !== undefined ? { field } : {}),
			message,
			path: entity.filePath,
		});
	};

	// ---- choices_of: names an existing entity's enum field with literal choices.
	for (const e of entities) {
		const name = e.definition.entity.name;
		for (const [fieldName, field] of Object.entries(e.definition.fields)) {
			if (field.choices_of === undefined) continue;
			const [ownerName, ownerField] = field.choices_of.split('.') as [string, string];
			const where = `'${name}.${fieldName}': choices_of '${field.choices_of}'`;
			const owner = byName.get(ownerName);
			if (ownerName === name) {
				error(e, 'choices_of_invalid', `R1 — ${where} names the entity's own field. Share an enum with ANOTHER entity, or declare literal 'choices:' here.`, fieldName);
			} else if (owner === undefined) {
				error(e, 'choices_of_invalid', `R1 — ${where}: there is no entity '${ownerName}'.`, fieldName);
			} else {
				const target = owner.definition.fields[ownerField];
				if (target === undefined) {
					error(e, 'choices_of_invalid', `R1 — ${where}: '${ownerName}' declares no field '${ownerField}'.`, fieldName);
				} else if (target.type !== 'enum') {
					error(e, 'choices_of_invalid', `R1 — ${where}: '${ownerName}.${ownerField}' is 'type: ${target.type}', not an enum.`, fieldName);
				} else if (target.choices_of !== undefined || target.choices_from !== undefined || !target.choices?.length) {
					error(
						e,
						'choices_of_invalid',
						`R1 — ${where}: '${ownerName}.${ownerField}' must declare literal 'choices:'. ` +
							`'choices_of' does not chain through another 'choices_of' or 'choices_from'.`,
						fieldName,
					);
				}
			}
		}
	}

	// ---- Families.
	const childrenOf = new Map<string, InheritanceEntity[]>();
	for (const e of entities) {
		const child = inheritsOf(e.definition);
		if (child === null) continue;
		const name = e.definition.entity.name;
		const baseEntity = byName.get(child.base);

		if (child.base === name) {
			error(e, 'inherits_invalid', `R3 — '${name}' inherits itself.`);
			continue;
		}
		if (baseEntity === undefined) {
			error(e, 'inherits_invalid', `R3 — '${name}' inherits '${child.base}', but there is no entity '${child.base}'.`);
			continue;
		}
		const base = baseEntity.definition;
		const list = childrenOf.get(child.base) ?? [];
		list.push(e);
		childrenOf.set(child.base, list);

		// R3: one level.
		if (inheritsOf(base) !== null) {
			error(
				e,
				'inherits_invalid',
				`R3 — '${name}' inherits '${child.base}', which itself inherits '${inheritsOf(base)!.base}'. ` +
					`Inheritance is one level: a base cannot be a child.`,
			);
			continue;
		}

		// R1: the base names the discriminator the child's kind is checked against.
		if (base.discriminator === undefined) {
			error(
				e,
				'inherits_invalid',
				`R1 — '${name}' inherits '${child.base}', which declares no 'discriminator:'. ` +
					`Name the base's kind enum field there.`,
			);
			continue;
		}
		const choices = resolveChoices(byName, base, base.discriminator);
		if (choices === undefined) {
			// The base's own discriminator problem is reported on the base (R1, single file / choices_of).
			continue;
		}
		if (!choices.includes(child.as)) {
			error(
				e,
				'inherits_invalid',
				`R2 — '${name}' is the '${child.as}' kind of '${child.base}', but '${child.base}.${base.discriminator}' ` +
					`has no choice '${child.as}' (choices: ${choices.join(', ')}). ` +
					`Add it to the base, or name the kind with 'inherits: { base: ${child.base}, as: <choice> }'.`,
			);
		}

		// R4: nothing is declared on both tables.
		const baseOwn = ownNames(base);
		const baseImplicit = implicitColumns(base, tenancyColumn);
		const childOwn = ownNames(e.definition);
		for (const [n, what] of childOwn) {
			const baseHas = baseOwn.get(n) ?? baseImplicit.get(n);
			if (baseHas !== undefined) {
				error(
					e,
					'inherits_name_collision',
					`R4 — '${name}' declares ${what}, and its base '${child.base}' declares ${baseHas}. ` +
						`DTOs and flat rows merge the two, so a name belongs to one table: rename it on '${name}' or drop it.`,
					n,
				);
			}
		}
		// The two derived relation keys: the child's edge to its base, the base's edge to the child.
		const childEdge = childOwn.get(child.base) ?? implicitColumns(e.definition, tenancyColumn).get(child.base);
		if (childEdge !== undefined) {
			error(
				e,
				'inherits_name_collision',
				`R4 — '${name}' declares ${childEdge}, which is the name of the relation to its base '${child.base}' ` +
					`(the generator adds it). Rename it.`,
				child.base,
			);
		}
		const baseEdge = baseOwn.get(name) ?? baseImplicit.get(name);
		if (baseEdge !== undefined) {
			error(
				baseEntity,
				'inherits_name_collision',
				`R4 — '${child.base}' declares ${baseEdge}, which is the name of the relation to its child '${name}' ` +
					`(the generator adds it). Rename it.`,
				name,
			);
		}

		// R6: a child's pattern config names only its own columns.
		const ownColumns = new Set<string>([
			...Object.keys(e.definition.fields),
			...[...childOwn.keys()],
		]);
		const baseColumns = new Set<string>([
			...Object.keys(base.fields),
			...[...baseOwn.keys()],
			...[...baseImplicit.keys()],
		]);
		const baseOnly = (col: string) => baseColumns.has(col) && !ownColumns.has(col);
		const config = e.definition.entity.config ?? {};
		for (const [pattern, value] of Object.entries(config)) {
			for (const leaf of stringLeaves(value)) {
				if (baseOnly(leaf)) {
					error(
						e,
						'inherits_pattern_config',
						`R6 — '${name}' configures pattern '${pattern}' with '${leaf}', a column that its base '${child.base}' ` +
							`owns. A pattern is declared on the table that owns its columns: declare it on '${child.base}'.`,
						leaf,
					);
				}
			}
		}
		const patterns = [e.definition.entity.pattern, ...(e.definition.entity.patterns ?? [])];
		const configuredOccurred = (config.Activity as { occurredAt?: string } | undefined)?.occurredAt;
		if (patterns.includes('Activity') && configuredOccurred === undefined) {
			// No `occurredAt` configured: the pattern reads its default column (already reported above when configured).
			const occurred = 'occurred_at';
			if (baseOnly(occurred)) {
				error(
					e,
					'inherits_pattern_config',
					`R6 — '${name}' declares pattern 'Activity', which reads the recency column '${occurred}', ` +
						`and its base '${child.base}' owns that column. Declare 'Activity' on '${child.base}'.`,
					occurred,
				);
			}
		}

		// R7: a child's queries name only its own columns.
		for (const q of e.definition.queries ?? []) {
			for (const col of queryColumns(q)) {
				if (baseOnly(col)) {
					error(
						e,
						'inherits_query',
						`R7 — a query on '${name}' names '${col}', a column of its base '${child.base}'. ` +
							`A finder by a base column is a read on the base: declare it on '${child.base}'.`,
						col,
					);
				}
			}
		}

		// R8: one sync mode per family.
		if (e.definition.entity.sync !== base.entity.sync) {
			const show = (s: string | undefined) => (s === undefined ? 'undeclared' : `'${s}'`);
			error(
				e,
				'inherits_sync',
				`R8 — '${name}' has entity.sync ${show(e.definition.entity.sync)} and its base '${child.base}' has ` +
					`${show(base.entity.sync)}. A family shares one sync mode: declare the same 'sync:' on both, or on neither.`,
			);
		}
	}

	// R2 (each kind has at most one child), and R3/R10 on each base.
	for (const [baseName, children] of childrenOf) {
		const byKind = new Map<string, string[]>();
		for (const c of children) {
			const kind = inheritsOf(c.definition)!.as;
			byKind.set(kind, [...(byKind.get(kind) ?? []), c.definition.entity.name]);
		}
		for (const [kind, names] of byKind) {
			if (names.length > 1) {
				const second = children.find((c) => c.definition.entity.name === names[1])!;
				error(
					second,
					'inherits_invalid',
					`R2 — '${names.join("' and '")}' are both the '${kind}' kind of '${baseName}'. ` +
						`Each choice has at most one child; give one of them a different 'as:' (and a matching choice).`,
				);
			}
		}
	}
	for (const e of entities) {
		if (e.definition.discriminator === undefined) continue;
		const name = e.definition.entity.name;
		try {
			const issue = baseTenantColumnIssue(name, e.definition, tenancyColumn);
			if (issue !== null) error(e, 'inherits_tenancy', `R10 — ${issue}`);
		} catch (err) {
			error(e, 'inherits_tenancy', `R10 — ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ---- match: (M1–M5), on every belongs_to in the set.
	for (const e of entities) {
		const def = e.definition;
		const name = def.entity.name;
		const implicit = implicitColumns(def, tenancyColumn);
		// local column -> [relationship, target column type] already claimed (M3).
		const claimed = new Map<string, { rel: string; target: string; col: string; type: string | undefined }>();

		for (const [relName, rel] of Object.entries(def.relationships ?? {})) {
			if (rel.match === undefined) continue;
			if (rel.type !== 'belongs_to') continue; // M1 (single-file half) is the schema's.
			const target = byName.get(rel.target);
			if (target === undefined) continue; // an unknown target is reported by reference resolution.
			const t = target.definition;
			const where = `'${name}.${relName}' (match → '${rel.target}')`;

			// M4 (static corollary): a SET NULL action would rewrite the matched columns.
			if (rel.on_delete === 'set_null') {
				error(
					e,
					'match_invalid',
					`M4 — ${where} uses 'on_delete: set_null'. Postgres would null every column of the composite key, ` +
						`so the matched column would change while the foreign key is not being changed by the author. ` +
						`Use 'restrict', 'cascade' or 'no_action'.`,
					relName,
				);
			}

			for (const [local, targetCol] of matchPairs(rel.match)) {
				// M1: the target column exists and is NOT NULL.
				const notNull = columnNotNull(t, targetCol);
				if (notNull === undefined) {
					error(
						e,
						'match_invalid',
						`M1 — ${where}: '${rel.target}' declares no field or foreign key column '${targetCol}'. ` +
							`The target side of a match is a column of '${rel.target}'.`,
						relName,
					);
					continue;
				}
				if (!notNull) {
					error(
						e,
						'match_invalid',
						`M1 — ${where}: '${rel.target}.${targetCol}' is nullable. A composite foreign key is not checked ` +
							`for a NULL, so the target column must be 'required: true'.`,
						relName,
					);
				}

				// M2: the local column is derived — it may not already be declared — except the entity's own discriminator.
				const targetField = t.fields[targetCol];
				const isDiscriminator = def.discriminator === local;
				const taken = declaresColumn(def, local)
					? `a declared ${def.fields[local] !== undefined ? 'field' : 'foreign key column'}`
					: implicit.get(local);
				if (taken !== undefined) {
					if (!isDiscriminator) {
						error(
							e,
							'match_invalid',
							`M2 — ${where}: the local column '${local}' is already ${taken} on '${name}'. ` +
								`A match column is derived from the target, so it must not be declared. The one exception is the ` +
								`entity's own discriminator, when its enum is the target column's (choices_of: ${rel.target}.${targetCol}).`,
							relName,
						);
						continue;
					}
					const local_ = def.fields[local]!;
					const expected = `${rel.target}.${targetCol}`;
					if (local_.choices_of === undefined) {
						error(
							e,
							'match_invalid',
							`M2 — ${where}: '${name}.${local}' is the discriminator, but its enum is not '${expected}'. ` +
								`A match may name the entity's own discriminator only when it shares the target column's enum: ` +
								`declare it 'choices_of: ${expected}'.`,
							relName,
						);
						continue;
					}
					if (local_.choices_of !== expected) {
						error(
							e,
							'match_invalid',
							`M5 — ${where}: '${name}.${local}' takes its enum from '${local_.choices_of}', but the match is against ` +
								`'${expected}'. A composite foreign key needs one Postgres enum type on both sides: ` +
								`declare it 'choices_of: ${expected}'.`,
							relName,
						);
						continue;
					}
					if (targetField?.type !== 'enum') {
						error(
							e,
							'match_invalid',
							`M5 — ${where}: '${name}.${local}' is an enum but '${expected}' is 'type: ${targetField?.type ?? 'unknown'}'.`,
							relName,
						);
						continue;
					}
				}

				// M3: one local column may be matched by two relationships only if the target columns share a SQL type.
				const type = sqlTypeKey(t, targetCol);
				const prior = claimed.get(local);
				if (prior !== undefined) {
					if (prior.type !== type) {
						const bothEnum = prior.type?.startsWith('enum:') && type?.startsWith('enum:');
						error(
							e,
							'match_invalid',
							`${bothEnum ? 'M5' : 'M3'} — '${name}' matches the local column '${local}' from two relationships whose ` +
								`target columns differ in type: '${prior.rel}' → '${prior.target}.${prior.col}' (${prior.type}) and ` +
								`'${relName}' → '${rel.target}.${targetCol}' (${type}).` +
								(bothEnum
									? ` An enum needs one Postgres type on both sides: declare '${rel.target}.${targetCol}' ` +
										`(or '${prior.target}.${prior.col}') as 'choices_of:' the other.`
									: ''),
							relName,
						);
					}
					continue;
				}
				claimed.set(local, { rel: relName, target: rel.target, col: targetCol, type });
			}
		}
	}

	return issues;
}
