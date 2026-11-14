/**
 * Joined-table inheritance — the single-file half of RFC-0006's rules (#875).
 *
 * Everything here reads ONE entity's YAML; the rules that read two files (the
 * base's choices, a child's collisions with its base, `match:` targets) are in
 * `src/parser/validate-inheritance.ts`, which reads the parsed model. The two
 * halves share `inheritsOf` ("which entity is a child, which a base, what is its
 * kind value"); each keeps its own column lookup because it reads a different
 * model (raw YAML here, `ParsedEntity` there).
 *
 * Rule numbers are the RFC's (§1.2 R1–R11, §2.4 M1–M5, §8 refusals).
 */

import { declaredPatternNames } from '../patterns/compose.js';
import type { EntityDefinition } from './entity-definition.schema.js';
import { fieldColumnNullable, foreignKeyColumnNullable } from './field-nullability.js';
import { BASE_ONLY_BEHAVIORS, isTenantScoped, lifecycleBehaviorsDeclared } from './tenancy.js';

export interface InheritsDeclaration {
	base: string;
	/** The kind value: the long form's `as:`, else the entity's own name. */
	as: string;
}

/** The parsed `inherits:` of an entity — `null` for a base or a plain entity. */
export function inheritsOf(
	def: Pick<EntityDefinition, 'inherits'> & { entity: { name: string } },
): InheritsDeclaration | null {
	const raw = def.inherits;
	if (raw === undefined) return null;
	if (typeof raw === 'string') return { base: raw, as: def.entity.name };
	return { base: raw.base, as: raw.as ?? def.entity.name };
}

/**
 * `match:` as `[local column, target column]` pairs — the ONE normaliser of the
 * two spellings (the object form, and the `[col]` shorthand for `{ col: col }`).
 * Every reader — the schema, the parsed model (`load-entities.ts`), the
 * validator, the hygen templates — goes through it. Empty without a `match:`.
 */
export function matchPairsOf(rel: { match?: readonly string[] | Readonly<Record<string, string>> | null }): Array<[string, string]> {
	const m = rel.match;
	if (m === undefined || m === null) return [];
	if (Array.isArray(m)) return m.map((c): [string, string] => [c, c]);
	return Object.entries(m as Record<string, string>);
}

/**
 * The entities a rendered entity's table depends on, besides itself (RFC-0006
 * §2): its BASE (which carries the uniques the child's two composite FKs point
 * at) and every `match:` relationship's TARGET (which carries
 * `unique(id, <matched columns>)`). Shape-neutral: the raw YAML and the parsed
 * model both reduce to it, so family discovery is written once.
 */
export function inheritanceCounterpartNames(def: {
	base: string | null;
	relationships: Iterable<{ type: string; target: string; match?: readonly string[] | Readonly<Record<string, string>> | null }>;
}): string[] {
	const out: string[] = [];
	if (def.base !== null) out.push(def.base);
	for (const rel of def.relationships) {
		if (rel.type === 'belongs_to' && matchPairsOf(rel).length > 0 && !out.includes(rel.target)) out.push(rel.target);
	}
	return out;
}

/** One issue: a YAML path and a message that names the entity. */
export interface InheritanceIssue {
	path: (string | number)[];
	message: string;
}

/** Whether the column is NOT NULL, for a declared field or FK column; `undefined` when not declared. */
export function columnNotNull(def: EntityDefinition, column: string): boolean | undefined {
	for (const rel of Object.values(def.relationships ?? {})) {
		if (rel.type === 'belongs_to' && rel.foreign_key === column) {
			return !foreignKeyColumnNullable(rel.nullable, def.fields[column]);
		}
	}
	const field = def.fields[column];
	return field === undefined ? undefined : !fieldColumnNullable(field);
}

/**
 * R1 (own-file half), R3, R5, R9, R11 and §8's v1 refusals for one entity.
 * Pure: returns the issues, the Zod refinement adds them.
 */
export function inheritanceIssues(def: EntityDefinition): InheritanceIssue[] {
	const issues: InheritanceIssue[] = [];
	const name = def.entity.name;
	const child = inheritsOf(def);
	const isBase = def.discriminator !== undefined;
	const add = (path: (string | number)[], message: string) => issues.push({ path, message });

	// ---- R1: `discriminator:` names a required enum with a known choice list.
	if (def.discriminator !== undefined) {
		const field = def.fields[def.discriminator];
		const where = `'${name}': discriminator '${def.discriminator}'`;
		if (field === undefined) {
			add(
				['discriminator'],
				`R1 — ${where} names no field. Declare it under fields: as a 'type: enum, required: true' field.`,
			);
		} else if (field.type !== 'enum') {
			add(['discriminator'], `R1 — ${where} must be a 'type: enum' field, but it is 'type: ${field.type}'.`);
		} else if (field.required !== true) {
			add(
				['discriminator'],
				`R1 — ${where} must be 'required: true': it is the foreign key target of every child and the tag of the union.`,
			);
		} else if (field.choices_from !== undefined) {
			add(
				['discriminator'],
				`R1 — ${where} takes its choices from a file ('choices_from'). A discriminator lists literal 'choices:' ` +
					`or takes another entity's with 'choices_of: <entity>.<field>', so the kinds are known when the family is validated.`,
			);
		} else if (!field.choices?.length && field.choices_of === undefined) {
			add(['discriminator'], `R1 — ${where} needs literal 'choices:' or 'choices_of: <entity>.<field>'.`);
		}
	}

	// ---- R3 (own-file half): one level. A child declares no discriminator.
	if (child !== null && isBase) {
		add(
			['discriminator'],
			`R3 — '${name}' inherits '${child.base}' and also declares 'discriminator:'. ` +
				`Inheritance is one level: a child cannot be a base.`,
		);
	}

	// ---- R9: no EAV or junction in a family.
	if (child !== null || isBase) {
		const role = child !== null ? `a child of '${child.base}'` : `the base of a family (discriminator '${def.discriminator}')`;
		if (def.eav === true) {
			add(['eav'], `R9 — '${name}' is ${role} and declares 'eav: true'. EAV is refused anywhere in a family in v1.`);
		}
		if (declaredPatternNames(def.entity).includes('Junction')) {
			add(
				['entity', def.entity.patterns ? 'patterns' : 'pattern'],
				`R9 — '${name}' is ${role} and declares 'pattern: Junction'. Junctions are refused anywhere in a family in v1.`,
			);
		}
		// §8: one key shape — a uuid `id` the template emits. A declared `id` field is a second key.
		const idField = def.fields.id;
		if (child !== null && idField !== undefined) {
			add(
				['fields', 'id'],
				`'${name}' is a child of '${child.base}' and declares a field 'id'. The child's key is the base row's id ` +
					`(a primary key that is also a foreign key); it is emitted, not declared.`,
			);
		} else if (idField !== undefined && idField.type !== 'uuid') {
			add(
				['fields', 'id'],
				`'${name}' is the base of a family and declares 'id' as 'type: ${idField.type}'. A family's key is a uuid ` +
					`(a non-uuid or composite key is refused in v1).`,
			);
		}
	}

	if (child !== null) {
		// ---- R5: lifecycle and scope are declared on the base.
		if (isTenantScoped(def.tenant_scoped)) {
			add(
				['tenant_scoped'],
				`R5 — '${name}' is a child of '${child.base}' and declares 'tenant_scoped:'. Tenancy is declared on the ` +
					`base ('${child.base}') only; the child takes its column and its strict scoping from it.`,
			);
		}
		for (const behavior of lifecycleBehaviorsDeclared(def)) {
			add(
				['behaviors'],
				`R5 — '${name}' is a child of '${child.base}' and declares or implies the '${behavior}' behavior. ` +
					`'${BASE_ONLY_BEHAVIORS.join("', '")}' live on the base ` +
					`('${child.base}') only.`,
			);
		}

		// ---- §8: refused on a child in v1.
		const refuse = (key: string, path: (string | number)[], why: string) =>
			add(path, `'${name}' is a child of '${child.base}' and declares ${key}. ${why}`);
		if (declaredPatternNames(def.entity).includes('Integrated')) {
			refuse(
				"'pattern: Integrated'",
				['entity', def.entity.patterns ? 'patterns' : 'pattern'],
				"The integration upsert's conflict target and write columns are one table's, so 'Integrated' on a child is refused in v1 (RFC-0006 §4.2, S7).",
			);
		}
		if (def.entity.surface !== undefined) {
			refuse("'surface:'", ['entity', 'surface'], 'Integration surfaces are refused on a child in v1.');
		}
		if (def.integration !== undefined) {
			refuse("'integration:'", ['integration'], 'Integration is refused on a child in v1.');
		}
		if (def.detection !== undefined) {
			refuse("'detection:'", ['detection'], 'Change detection is refused on a child in v1.');
		}
		if (def.eav_value_table === true) {
			refuse("'eav_value_table: true'", ['eav_value_table'], 'An EAV value table on a child is refused in v1 (RFC-0006 §8).');
		}
	}

	// ---- R11: the natural key.
	const naturalKeys = (def.unique_indexes ?? []).flatMap((entry, i) =>
		entry.natural_key === true ? [{ entry, i }] : [],
	);
	if (naturalKeys.length > 1) {
		add(
			['unique_indexes', naturalKeys[1]!.i, 'natural_key'],
			`R11 — '${name}' marks ${naturalKeys.length} unique_indexes entries 'natural_key: true'. At most one ` +
				`entry is the ON CONFLICT target of the upsert.`,
		);
	}
	for (const { entry, i } of naturalKeys) {
		if (child !== null) {
			add(
				['unique_indexes', i, 'natural_key'],
				`R11 — '${name}' is a child of '${child.base}' and declares 'natural_key: true'. A child declares none: ` +
					`its upsert uses the base's natural key ('${child.base}').`,
			);
			continue;
		}
		if (entry.where !== undefined) {
			add(
				['unique_indexes', i, 'natural_key'],
				`R11 — '${name}': the natural_key entry ${JSON.stringify(entry.fields)} is a partial index ('where'). ` +
					`A partial index cannot be an ON CONFLICT target without its predicate; drop 'where'.`,
			);
		}
		for (const column of entry.fields) {
			const notNull = columnNotNull(def, column);
			if (notNull === undefined) {
				add(
					['unique_indexes', i, 'fields'],
					`R11 — '${name}': natural_key column '${column}' is not a declared field or foreign key column.`,
				);
			} else if (!notNull) {
				add(
					['unique_indexes', i, 'fields'],
					`R11 — '${name}': natural_key column '${column}' is nullable. A NULL in the key never conflicts, so the ` +
						`upsert would insert a duplicate; declare it 'required: true'.`,
				);
			}
		}
	}

	return issues;
}
