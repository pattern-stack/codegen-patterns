/**
 * Joined-table inheritance cross-validator (RFC-0006, #875)
 *
 * Runs over the whole parsed entity set because every rule here reads two
 * entities: a child against its base, a `match:` against its target, a
 * `choices_of:` against its owner. It reads `ParsedEntity`, not raw YAML: that
 * is the model S3's relation graph reads, and it already holds the columns a
 * `roles:` entry derives. The rules that read one file live in
 * `src/schema/inheritance.ts` (a Zod refinement).
 *
 *   R1  `choices_of:`'s target (no chains); a child's base declares a discriminator
 *   R2  each choice has at most one child; `as:` is one of the base's choices
 *   R3  one level: a base may not itself inherit
 *   R4  no name is declared on both a child and its base
 *   R6  a child declares a pattern only over its own columns
 *   R7  a child's `queries:` name only its own columns
 *   R8  base and children share one RESOLVED sync mode
 *   R10 a `tenant_scoped` base declares its tenant column NOT NULL
 *   M1–M5  `match:` (composite FK) targets, local columns and types
 *
 * Pure and framework-agnostic, like `validate-emits.ts` and
 * `validate-semantic.ts`: it never throws and returns issues; the CLI surfaces
 * them. Every message names the entities (and fields) involved.
 */

import type { AnalysisIssue, ParsedEntity, ParsedRelationship } from '../analyzer/types.js';
import { getBehavior } from '../behaviors/index.js';
import { declaredPatternNames } from '../patterns/compose.js';
import { getPattern } from '../patterns/registry.js';
import { resolveImpliedBehaviors } from '../patterns/implied-behaviors.js';
import { foreignKeyColumnNullable } from '../schema/field-nullability.js';
import { inheritanceCounterpartNames, matchPairsOf } from '../schema/inheritance.js';
import {
	baseTenantColumnIssue,
	tenantColumnName,
	type TenancyEntityInput,
} from '../schema/tenancy.js';

export interface ValidateInheritanceOptions {
	/** The project's `tenancy.column`, resolved through `TenancyConfigSchema` by the caller (the one owner of the default). */
	tenancyColumn: string;
	/** The project's `frontend.sync.mode`, which an entity with no `sync:` resolves to, resolved through `FrontendSyncConfigSchema` by the caller. */
	syncMode: 'api' | 'electric';
}

/** The parsed model as the tenancy helpers read it. */
function tenancyInput(e: ParsedEntity): TenancyEntityInput {
	return {
		entity: { pattern: e.pattern, patterns: e.patterns },
		behaviors: e.behaviors,
		tenant_scoped: e.tenantScoped,
		fields: Object.fromEntries(
			[...e.fields].map(([n, f]) => [n, { type: f.type, required: f.required, nullable: f.nullable }]),
		),
		relationships: Object.fromEntries(
			[...e.relationships].map(([n, r]) => [n, { type: r.type, foreign_key: r.foreignKey, nullable: r.nullable }]),
		),
	};
}

/** The names a table declares on its own: fields, FK columns, relation and role keys, and the columns a `match:` derives. */
function ownNames(e: ParsedEntity): Map<string, string> {
	const names = new Map<string, string>();
	const add = (n: string, what: string) => {
		if (!names.has(n)) names.set(n, what);
	};
	for (const f of e.fields.keys()) add(f, `field '${f}'`);
	for (const [key, rel] of e.relationships) {
		add(key, rel.role !== undefined ? `role '${key}'` : `relationship '${key}'`);
		if (rel.type === 'belongs_to') {
			add(
				rel.foreignKey,
				rel.role !== undefined
					? `foreign key '${rel.foreignKey}' (role '${key}')`
					: `foreign key '${rel.foreignKey}' (relationship '${key}')`,
			);
		}
	}
	for (const key of e.roles?.keys() ?? []) add(key, `role '${key}'`);
	// A `match:` derives its local column when the entity does not declare it (RFC-0006 §2.4).
	for (const [key, rel] of e.relationships) {
		for (const [local] of matchPairsOf(rel)) {
			if (!e.fields.has(local)) add(local, `column '${local}' derived by the match: of relationship '${key}'`);
		}
	}
	return names;
}

/** The columns a behavior, the tenant block or (for a child) the family adds to a table, besides its declared fields. */
function implicitColumns(
	e: ParsedEntity,
	tenancyColumn: string,
	base?: ParsedEntity,
): Map<string, string> {
	const cols = new Map<string, string>([['id', "the primary key 'id'"]]);
	const implied = resolveImpliedBehaviors({ pattern: e.pattern, patterns: e.patterns });
	for (const name of new Set([...e.behaviors, ...implied])) {
		for (const f of getBehavior(name)?.fields ?? []) cols.set(f.name, `the '${f.name}' column of the '${name}' behavior`);
	}
	for (const patternName of declaredPatternNames(e)) {
		for (const c of getPattern(patternName)?.columns ?? []) {
			cols.set(c.name, `the '${c.name}' column of the '${patternName}' pattern`);
		}
	}
	const tenant = tenantColumnName(e.tenantScoped, tenancyColumn);
	if (tenant !== null) cols.set(tenant, `the tenant column '${tenant}'`);
	if (base !== undefined) {
		// A child carries its base's kind and tenant column (RFC-0006 §2.1), pinned by the composite FKs.
		if (base.discriminator !== undefined) {
			cols.set(base.discriminator, `the '${base.discriminator}' column the child carries from its base '${base.name}'`);
		}
		const baseTenant = tenantColumnName(base.tenantScoped, tenancyColumn);
		if (baseTenant !== null) cols.set(baseTenant, `the tenant column '${baseTenant}' the child carries from its base '${base.name}'`);
	}
	return cols;
}

/** The literal choice list of an enum field, following ONE `choices_of:` hop; `undefined` when unknown. */
function resolveChoices(
	byName: Map<string, ParsedEntity>,
	e: ParsedEntity,
	field: string,
): string[] | undefined {
	const f = e.fields.get(field);
	if (f === undefined) return undefined;
	if (f.choices?.length) return f.choices;
	if (f.choicesOf !== undefined) {
		const [entity, targetField] = f.choicesOf.split('.') as [string, string];
		const target = byName.get(entity)?.fields.get(targetField);
		return target?.choices?.length ? target.choices : undefined;
	}
	return undefined;
}

/**
 * The SQL type identity of a column for M2 / M3 / M5: two columns are
 * comparable when this string is equal. An enum's identity is the entity that
 * owns its `pgEnum` — the field's own entity, or the `choices_of:` owner.
 */
function sqlTypeKey(e: ParsedEntity, column: string): string | undefined {
	const f = e.fields.get(column);
	if (f === undefined) {
		const isFk = [...e.relationships.values()].some((r) => r.type === 'belongs_to' && r.foreignKey === column);
		return isFk ? 'uuid' : undefined;
	}
	if (f.type === 'enum') return f.choicesOf !== undefined ? `enum:${f.choicesOf}` : `enum:${e.name}.${column}`;
	return f.type;
}

/** Whether a declared column is NOT NULL; `undefined` when the entity does not declare it. */
function columnNotNull(e: ParsedEntity, column: string): boolean | undefined {
	for (const rel of e.relationships.values()) {
		if (rel.type === 'belongs_to' && rel.foreignKey === column) {
			// `ParsedField.nullable` already folds the FK rule in for a declared FK field.
			const field = e.fields.get(column);
			return !foreignKeyColumnNullable(rel.nullable, field ? { nullable: field.nullable } : undefined);
		}
	}
	const f = e.fields.get(column);
	return f === undefined ? undefined : !f.nullable;
}

/** Whether the entity declares the column itself (a field or an FK column). */
function declaresColumn(e: ParsedEntity, column: string): 'field' | 'foreign key column' | undefined {
	if (e.fields.has(column)) return 'field';
	for (const rel of e.relationships.values()) {
		if (rel.type === 'belongs_to' && rel.foreignKey === column) return 'foreign key column';
	}
	return undefined;
}

/** Cross-validate the whole entity set. Never throws. */
export function validateInheritance(
	entities: ParsedEntity[],
	options: ValidateInheritanceOptions,
): AnalysisIssue[] {
	const { tenancyColumn, syncMode } = options;
	const issues: AnalysisIssue[] = [];
	const byName = new Map<string, ParsedEntity>();
	for (const e of entities) byName.set(e.name, e);

	const error = (entity: ParsedEntity, type: string, message: string, field?: string): void => {
		issues.push({
			severity: 'error',
			type,
			entity: entity.name,
			...(field !== undefined ? { field } : {}),
			message,
			path: entity.sourcePath,
		});
	};

	// ---- choices_of: names an existing entity's enum field with literal choices.
	for (const e of entities) {
		for (const [fieldName, field] of e.fields) {
			if (field.choicesOf === undefined) continue;
			const [ownerName, ownerField] = field.choicesOf.split('.') as [string, string];
			const where = `'${e.name}.${fieldName}': choices_of '${field.choicesOf}'`;
			const owner = byName.get(ownerName);
			if (ownerName === e.name) {
				error(e, 'choices_of_invalid', `R1 — ${where} names the entity's own field. Share an enum with ANOTHER entity, or declare literal 'choices:' here.`, fieldName);
			} else if (owner === undefined) {
				error(e, 'choices_of_invalid', `R1 — ${where}: there is no entity '${ownerName}'.`, fieldName);
			} else {
				const target = owner.fields.get(ownerField);
				if (target === undefined) {
					error(e, 'choices_of_invalid', `R1 — ${where}: '${ownerName}' declares no field '${ownerField}'.`, fieldName);
				} else if (target.type !== 'enum') {
					error(e, 'choices_of_invalid', `R1 — ${where}: '${ownerName}.${ownerField}' is 'type: ${target.type}', not an enum.`, fieldName);
				} else if (target.choicesOf !== undefined || target.choicesFrom !== undefined || !target.choices?.length) {
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
	const childrenOf = new Map<string, ParsedEntity[]>();
	for (const e of entities) {
		const child = e.inherits;
		if (child === undefined) continue;
		const name = e.name;
		const base = byName.get(child.base);

		if (child.base === name) {
			error(e, 'inherits_invalid', `R3 — '${name}' inherits itself.`);
			continue;
		}
		if (base === undefined) {
			error(e, 'inherits_invalid', `R3 — '${name}' inherits '${child.base}', but there is no entity '${child.base}'.`);
			continue;
		}
		const list = childrenOf.get(child.base) ?? [];
		list.push(e);
		childrenOf.set(child.base, list);

		// R3: one level.
		if (base.inherits !== undefined) {
			error(
				e,
				'inherits_invalid',
				`R3 — '${name}' inherits '${child.base}', which itself inherits '${base.inherits.base}'. ` +
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
		if (choices !== undefined && !choices.includes(child.as)) {
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
		const childOwn = ownNames(e);
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
		const childEdge = childOwn.get(child.base) ?? implicitColumns(e, tenancyColumn).get(child.base);
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
				base,
				'inherits_name_collision',
				`R4 — '${child.base}' declares ${baseEdge}, which is the name of the relation to its child '${name}' ` +
					`(the generator adds it). Rename it.`,
				name,
			);
		}

		// R6: a child declares a pattern only over the columns it owns.
		const baseColumns = new Set<string>([...baseOwn.keys(), ...baseImplicit.keys()]);
		const baseOnly = (col: string) => baseColumns.has(col) && !childOwn.has(col);
		for (const patternName of declaredPatternNames(e)) {
			const definition = getPattern(patternName);
			// Parsed through the pattern's own schema, as composition does: a config that fails it is
			// reported there, and reads as no config here.
			const parsed = definition?.configSchema?.safeParse(e.patternConfig?.[patternName] ?? {});
			if (definition === undefined || patternName === 'Base') continue;
			// Fails closed: a pattern that does not say which columns it reads cannot be shown to read only the
			// child's own, so declaring it on a child is an error naming the pattern (D1).
			if (definition.columnsRead === undefined) {
				error(
					e,
					'inherits_pattern_config',
					`R6 — '${name}' declares pattern '${patternName}', which does not state the columns it reads ` +
						`(no 'columnsRead'), so it cannot be checked against its base '${child.base}'. ` +
						`Declare it on '${child.base}', or give the pattern a 'columnsRead'.`,
				);
				continue;
			}
			const read = definition.columnsRead(parsed?.success ? parsed.data : undefined);
			for (const col of read) {
				if (baseOnly(col)) {
					error(
						e,
						'inherits_pattern_config',
						`R6 — '${name}' declares pattern '${patternName}', which reads the column '${col}', and its base ` +
							`'${child.base}' owns that column. A pattern is declared on the table that owns its columns: ` +
							`declare it on '${child.base}', or point its config at a column of '${name}'.`,
						col,
					);
				}
			}
		}

		// R7: a child's queries name only its own columns — by-column and search queries alike.
		const queryColumns: string[] = [
			...(e.queries ?? []).flatMap((q) => {
				const order = q.order?.trim().split(/\s+/)[0];
				return [...q.by, ...(q.select ?? []), ...(order ? [order] : [])];
			}),
			...(e.searchQueries ?? []).flatMap((q) => [...q.filters, ...(q.search !== undefined ? [q.search] : [])]),
		];
		for (const col of queryColumns) {
			if (baseOnly(col)) {
				error(
					e,
					'inherits_query',
					`R7 — a query on '${name}' names '${col}', a column of its base '${child.base}'. ` +
						`A finder or filter by a base column is a read on the base: declare it on '${child.base}'.`,
					col,
				);
			}
		}

		// R8: one RESOLVED sync mode per family (an undeclared mode is the global one).
		const childMode = e.sync ?? syncMode;
		const baseMode = base.sync ?? syncMode;
		if (childMode !== baseMode) {
			error(
				e,
				'inherits_sync',
				`R8 — '${name}' syncs '${childMode}' and its base '${child.base}' syncs '${baseMode}'` +
					` (an entity with no 'sync:' takes the project's frontend.sync.mode, '${syncMode}'). ` +
					`A family shares one sync mode: declare the same 'sync:' on both.`,
			);
		}
	}

	// R2 (each kind has at most one child), and R10 on each base.
	for (const [baseName, children] of childrenOf) {
		const byKind = new Map<string, string[]>();
		for (const c of children) byKind.set(c.inherits!.as, [...(byKind.get(c.inherits!.as) ?? []), c.name]);
		for (const [kind, names] of byKind) {
			if (names.length > 1) {
				error(
					children.find((c) => c.name === names[1])!,
					'inherits_invalid',
					`R2 — '${names.join("' and '")}' are both the '${kind}' kind of '${baseName}'. ` +
						`Each choice has at most one child; give one of them a different 'as:' (and a matching choice).`,
				);
			}
		}
	}
	for (const e of entities) {
		if (e.discriminator === undefined) continue;
		try {
			const issue = baseTenantColumnIssue(e.name, tenancyInput(e), tenancyColumn);
			if (issue !== null) error(e, 'inherits_tenancy', `R10 — ${issue}`);
		} catch (err) {
			// Not necessarily R10: a tenant column that collides with a behavior column or adopts a non-uuid
			// field is the tenancy resolver's own refusal, so it is reported as the resolver words it.
			error(e, 'inherits_tenancy', err instanceof Error ? err.message : String(err));
		}
	}

	// ---- match: (M1–M5), on every belongs_to in the set.
	for (const e of entities) {
		const name = e.name;
		const base = e.inherits !== undefined ? byName.get(e.inherits.base) : undefined;
		const implicit = implicitColumns(e, tenancyColumn, base);
		// local column -> the first relationship that matched it (M3).
		const claimed = new Map<string, { rel: string; target: string; col: string; type: string | undefined }>();

		for (const [relName, rel] of e.relationships) {
			if (rel.match === undefined || rel.type !== 'belongs_to') continue; // M1 (single-file half) is the schema's.
			const target = byName.get(rel.target);
			if (target === undefined) continue; // an unknown target is reported by reference resolution.
			const where = `'${name}.${relName}' (match → '${rel.target}')`;

			// M4 (static corollary): a SET NULL action would rewrite the matched columns.
			if (rel.onDelete === 'set_null') {
				error(
					e,
					'match_invalid',
					`M4 — ${where} uses 'on_delete: set_null'. Postgres would null every column of the composite key, ` +
						`so the matched column would change while the foreign key is not being changed by the author. ` +
						`Use 'restrict', 'cascade' or 'no_action'.`,
					relName,
				);
			}

			for (const [local, targetCol] of matchPairsOf(rel)) {
				// M1: the target column exists and is NOT NULL.
				const notNull = columnNotNull(target, targetCol);
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

				// M2: the local column is derived — it may not already exist on the table — except the entity's own discriminator.
				const declared = declaresColumn(e, local);
				const taken = declared !== undefined ? `a declared ${declared}` : implicit.get(local);
				const type = sqlTypeKey(target, targetCol);
				if (taken !== undefined) {
					if (e.discriminator !== local || declared !== 'field') {
						error(
							e,
							'match_invalid',
							`M2 — ${where}: the local column '${local}' is already ${taken} on '${name}'. ` +
								`A match column is derived from the target, so it must not exist already. The one exception is the ` +
								`entity's own discriminator, when its enum is the target column's.`,
							relName,
						);
						continue;
					}
					// The exception: the discriminator's SQL type must BE the target column's.
					const localType = sqlTypeKey(e, local);
					if (localType !== type) {
						const targetIsEnum = type?.startsWith('enum:') === true;
						const localField = e.fields.get(local)!;
						if (targetIsEnum && localField.choicesOf !== undefined) {
							error(
								e,
								'match_invalid',
								`M5 — ${where}: '${name}.${local}' takes its enum from '${localField.choicesOf}', but the match is ` +
									`against '${rel.target}.${targetCol}'. A composite foreign key needs one Postgres enum type on both ` +
									`sides: declare it 'choices_of: ${rel.target}.${targetCol}'.`,
								relName,
							);
						} else if (targetIsEnum) {
							error(
								e,
								'match_invalid',
								`M2 — ${where}: '${name}.${local}' is the discriminator, but its enum is not '${rel.target}.${targetCol}'. ` +
									`A match may name the entity's own discriminator only when it shares the target column's enum: ` +
									`declare it 'choices_of: ${rel.target}.${targetCol}'.`,
								relName,
							);
						} else {
							error(
								e,
								'match_invalid',
								`M2 — ${where}: '${name}.${local}' is the discriminator (${localType}), but '${rel.target}.${targetCol}' ` +
									`is ${type}. The two columns of a composite foreign key must have one type.`,
								relName,
							);
						}
						continue;
					}
				}

				// M3: one local column may be matched by two relationships only if the target columns share a SQL type.
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

/**
 * The entities a rendered one's generated files read, and so must be rendered
 * with it (RFC-0006 §2): a child's BASE (its file imports the base's table and
 * `.enums` module, so the base must exist and validate) and every `match:`
 * relationship's TARGET (whose table carries the unique the composite FK points
 * at; its pgEnum is imported) (`inheritanceCounterpartNames`, the one reader of both
 * shapes). Names only; ones already in `rendered`, and the entity itself, are
 * left out.
 *
 * Only this direction exists. A base's output depends on its own YAML and on
 * its `match:` referrers' (the uniques their composite FKs point at) and NOT on
 * its children: adding a child changes no byte of the base. Rendering a child
 * re-renders the base so that a stale base becomes current, and a rejected base
 * rejects the child.
 */
export function inheritanceCounterparts(entities: ParsedEntity[], rendered: ReadonlySet<string>): string[] {
	const byName = new Map(entities.map((e) => [e.name, e]));
	const out: string[] = [];
	for (const name of rendered) {
		const e = byName.get(name);
		if (e === undefined) continue;
		const counterparts = inheritanceCounterpartNames({
			base: e.inherits?.base ?? null,
			relationships: e.relationships.values(),
		});
		for (const c of counterparts) {
			if (c === name || rendered.has(c) || out.includes(c) || !byName.has(c)) continue;
			out.push(c);
		}
	}
	return out;
}
