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

import { externalIdTrackingBehavior } from '../behaviors/external-id-tracking.js';
import { normalizeBehaviorConfig } from '../behaviors/index.js';
import { declaredPatternNames } from '../patterns/compose.js';
import type { EntityDefinition } from './entity-definition.schema.js';
import { fieldColumnNullable, foreignKeyColumnNullable } from './field-nullability.js';
import { BASE_ONLY_BEHAVIORS, isTenantScoped, lifecycleBehaviorsDeclared, type TenantScopedDeclaration } from './tenancy.js';

export interface InheritsDeclaration {
	base: string;
	/** The kind value: the long form's `as:`, else the entity's own name. */
	as: string;
}

/** The YAML path of a child's `inherits:` — the path every origin and relation id of it is spelled from. */
export const INHERITS_PATH = ['inherits'] as const;

/**
 * The natural key a sync of an Integrated child upserts on, and the only nullable columns R11 accepts in a key (S7, D1):
 * the behavior's declared `identityColumns`, never retyped here. `provider_metadata` is payload, not identity, so it is
 * not part of the key. An identity column the behavior does not declare as a field is a load-time error, not a
 * silently shorter key.
 */
export const INTEGRATED_NATURAL_KEY: readonly string[] = (() => {
	const identity = externalIdTrackingBehavior.identityColumns;
	if (identity === undefined || identity.length === 0) {
		throw new globalThis.Error(`'${externalIdTrackingBehavior.name}' declares no identityColumns`);
	}
	for (const column of identity) {
		if (!externalIdTrackingBehavior.fields.some((f) => f.name === column)) {
			throw new globalThis.Error(`'${externalIdTrackingBehavior.name}' identityColumns names '${column}', which it does not declare`);
		}
	}
	return identity;
})();

/** Whether a `behaviors:` list DECLARES `external_id_tracking` (a pattern that implies it does not count). */
export function declaresExternalIdTracking(behaviors: EntityDefinition['behaviors'] | null | undefined): boolean {
	return (behaviors ?? []).some((b) => normalizeBehaviorConfig(b).name === externalIdTrackingBehavior.name);
}

/** Whether `fields` is exactly {@link INTEGRATED_NATURAL_KEY}, in either order. */
export function isIntegratedNaturalKey(fields: readonly string[]): boolean {
	return fields.length === INTEGRATED_NATURAL_KEY.length && INTEGRATED_NATURAL_KEY.every((c) => fields.includes(c));
}

/**
 * The id of the `inherits` relation of a child — `<child>.inherits`, spelled as REL-1 spells an origin
 * (`[doc.name, ...path].join('.')`) over {@link INHERITS_PATH}. The ONE spelling: the derivation lists the relation under
 * it, REL-1's edge uses it as its origin, and the serialized graph hands it to Studio.
 */
export function inheritsRelationId(child: string): string {
	return [child, ...INHERITS_PATH].join('.');
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
 * The relation key of a family edge (RFC-0006 §3.1): the entity name camelCased, `[-_\s]` followed by a letter OR A
 * DIGIT (`call_2` → `call2`, matching the relations manifest's own `camelCase`, `src/emitters/relations/types.ts`).
 * The ONE owner — the manifest (`build-graph.ts`) names the edge with it and the generated repositories print the
 * same key into `with:`, so the two cannot disagree. `src/config/file-naming.ts`'s `camelCase` would keep `call_2`.
 */
export function familyRelationKey(entityName: string): string {
	return entityName.replace(/[-_\s]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** One child of a base, across an entity set: its name and the kind value it is `as`. */
export interface InheritanceChild {
	name: string;
	as: string;
}

/**
 * The children of `baseName` across a whole entity set — every entity whose `inherits:` names it, sorted by kind
 * value. The ONE answer to "does this base have child tables, and which": the generated family reads, the derived
 * API surface and the includes gate all read it (RFC-0006 §3.3, ADR-046).
 */
export function inheritanceChildrenOf(
	baseName: string,
	definitions: Iterable<Pick<EntityDefinition, 'inherits'> & { entity: { name: string } }>,
): InheritanceChild[] {
	const out: InheritanceChild[] = [];
	for (const def of definitions) {
		const d = inheritsOf(def);
		if (d !== null && d.base === baseName) out.push({ name: def.entity.name, as: d.as });
	}
	return out.sort((a, b) => (a.as < b.as ? -1 : a.as > b.as ? 1 : 0));
}

/**
 * The index, in `unique_indexes`, of the entry marked `natural_key: true` (R11: at most one) — `-1` when none.
 * The ONE reader of the marker: the generated `upsertByNaturalKey`'s conflict target and the derived API surface's
 * "does this entity upsert, and caused by which declaration" both read it (RFC-0006 §4.2, ADR-046).
 */
export function naturalKeyIndexOf(def: { unique_indexes?: readonly { natural_key?: boolean }[] | null }): number {
	return (def.unique_indexes ?? []).findIndex((entry) => entry.natural_key === true);
}

/** The base a child inherits, and whether that base declares a natural key (`naturalKeyIndex`, `-1` when none). */
export interface InheritanceBase {
	name: string;
	naturalKeyIndex: number;
}

/**
 * A child's base across the whole set — `null` for an entity that does not `inherits:`, or whose base has no
 * definition in the set (the validator refuses that; a lookup-less caller gets "unknown", not a fabricated base).
 */
export function inheritanceBaseOf(
	def: Pick<EntityDefinition, 'inherits'> & { entity: { name: string } },
	definitions: Iterable<{ entity: { name: string }; unique_indexes?: readonly { natural_key?: boolean }[] | null }>,
): InheritanceBase | null {
	const d = inheritsOf(def);
	if (d === null) return null;
	for (const candidate of definitions) {
		if (candidate.entity.name === d.base) return { name: d.base, naturalKeyIndex: naturalKeyIndexOf(candidate) };
	}
	return null;
}

/** What `enumChoices` reads of a field: literal `choices:`, or another entity's through `choices_of: <entity>.<field>`. */
export interface EnumChoicesField {
	choices?: readonly string[];
	choices_of?: string;
}

/**
 * The literal choice list of an enum field — its own `choices:`, or the owner's through `choices_of:
 * <entity>.<field>` (ONE hop; S1 refuses a chain). `undefined` when it cannot be read: not an enum, an unknown owner,
 * or an owner field without literal choices (the validator refuses those; "unknown", never "none").
 *
 * The ONE resolver: the validator (`resolveChoices`), the derivation (`discriminatorKindsOf`) and the templates'
 * `resolveEnumField` all take their choices from here, so a base's kinds cannot differ between the check, the DTO
 * `z.enum` and the decision whether the base has a create (`createDisabledBy`).
 */
export function enumChoices(
	field: EnumChoicesField | undefined,
	getDefinition: (entityName: string) => { fields?: Readonly<Record<string, EnumChoicesField>> } | undefined,
): string[] | undefined {
	if (field === undefined) return undefined;
	if (field.choices !== undefined && field.choices.length > 0) return [...field.choices];
	if (field.choices_of !== undefined) {
		const [ownerName, ownerField] = String(field.choices_of).split('.');
		if (ownerName === undefined || ownerField === undefined) return undefined;
		const owned = getDefinition(ownerName)?.fields?.[ownerField]?.choices;
		return owned !== undefined && owned.length > 0 ? [...owned] : undefined;
	}
	return undefined;
}

/**
 * The kinds a base's discriminator admits — `enumChoices` of the discriminator field; `null` for an entity with no
 * `discriminator:`, or when the list cannot be read from the set.
 */
export function discriminatorKindsOf(
	def: { discriminator?: string; fields?: Readonly<Record<string, EnumChoicesField>> },
	definitions: Iterable<{ entity: { name: string }; fields?: Readonly<Record<string, EnumChoicesField>> }>,
): string[] | null {
	if (typeof def.discriminator !== 'string') return null;
	const byName = new Map<string, { fields?: Readonly<Record<string, EnumChoicesField>> }>();
	for (const d of definitions) byName.set(d.entity.name, d);
	return enumChoices(def.fields?.[def.discriminator], (name) => byName.get(name)) ?? null;
}

/**
 * The kinds with no child table — the only ones a base's own `create` accepts (RFC-0006 §4.1, §5). Empty exactly when
 * every kind has a child, which is when the base has no create at all (`createDisabledBy`). The ONE computation:
 * `familyReads` (the DTO's `z.enum`, or `z.never()` when empty) and the derivation both call it.
 */
export function baseOnlyKinds(kinds: readonly string[], childKinds: readonly string[]): string[] {
	const withChild = new Set(childKinds);
	return kinds.filter((k) => !withChild.has(k));
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
 * §2): its BASE (whose table the child's two composite FKs point at,
 * and whose `.enums` module the child imports) and every `match:` relationship's TARGET (which carries
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

		// ---- §8: refused on a child in v1. (`pattern: Integrated`, `surface:`, `integration:` and `detection:` are
		// accepted since S7a: the child reads and syncs through its base, whose requirements are D1, checked in
		// `validate-inheritance.ts`.)
		if (def.eav_value_table === true) {
			add(
				['eav_value_table'],
				`'${name}' is a child of '${child.base}' and declares 'eav_value_table: true'. An EAV value table on a child is refused in v1 (RFC-0006 §8).`,
			);
		}
	}

	// ---- §8 / D2: Integrated on a base is refused (#927).
	if (isBase) {
		const refuseBase = (key: string, path: (string | number)[]) =>
			add(
				path,
				`'${name}' is the base of a family (discriminator '${def.discriminator}') and declares ${key}. ` +
					`Integration on a base is refused until #927: declare it on a child, and give the base ` +
					`'external_id_tracking' plus a 'natural_key: true' entry over [${INTEGRATED_NATURAL_KEY.join(', ')}] (RFC-0006 §4.2, S7).`,
			);
		if (declaredPatternNames(def.entity).includes('Integrated')) {
			refuseBase("'pattern: Integrated'", ['entity', def.entity.patterns ? 'patterns' : 'pattern']);
		}
		if (def.entity.surface !== undefined) refuseBase("'surface:'", ['entity', 'surface']);
		if (def.integration !== undefined) refuseBase("'integration:'", ['integration']);
		if (def.detection !== undefined) refuseBase("'detection:'", ['detection']);
	}

	// ---- R11: the natural key.
	const naturalKeys = (def.unique_indexes ?? []).flatMap((entry, i) =>
		entry.natural_key === true ? [{ entry, i }] : [],
	);
	if (naturalKeys.length > 1) {
		add(
			['unique_indexes', naturalKeys[1]!.i, 'natural_key'],
			`R11 — '${name}' marks ${naturalKeys.length} unique_indexes entries 'natural_key: true' ` +
				`(${naturalKeys.map(({ entry }) => JSON.stringify(entry.fields)).join(' and ')}). At most one ` +
				`entry is the ON CONFLICT target of the upsert.` +
				(isBase
					? ` An Integrated child's sync upserts its base on [${INTEGRATED_NATURAL_KEY.join(', ')}], so a base ` +
						`with an Integrated child declares that one and no other.`
					: ''),
		);
	}
	const declaresTracking = declaresExternalIdTracking(def.behaviors);
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
			// The `external_id_tracking` identity columns are nullable by design; a BASE that declares the behavior
			// may key on exactly the pair (S7, D1) — not on either alone, and not on any other entity. The runtime
			// upsert refuses a NULL in the key, so no duplicate can insert.
			if (notNull === undefined && isBase && declaresTracking && isIntegratedNaturalKey(entry.fields)) continue;
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

/** A declared field / relationship as the raw YAML parses it (what an emitter reads). */
export type DeclaredField = NonNullable<EntityDefinition['fields']>[string];
export type DeclaredRelationship = NonNullable<EntityDefinition['relationships']>[string];

/**
 * The keys of an entity the flat-shape walk reads — the structural input contract of {@link flatChildShape},
 * {@link flattenInheritedChild} and {@link flatChildOwners}. An emitter's own entity type satisfies it by declaring these
 * keys (`inherits` and `discriminator` included, so a projection that drops them is a compile error, not a silent no-op).
 * `F` and `R` are the field and relationship value types: the raw YAML's by default; the parsed model's for the
 * cross-entity validator, which walks the same shape over `ParsedEntity`.
 */
export interface FlatChildInput<F = DeclaredField, R = DeclaredRelationship> {
	entity: { name: string };
	inherits?: EntityDefinition['inherits'];
	discriminator?: EntityDefinition['discriminator'];
	fields?: Record<string, F>;
	behaviors?: EntityDefinition['behaviors'];
	tenant_scoped?: TenantScopedDeclaration;
	relationships?: Record<string, R>;
}

/** The flat shape of one joined-table child, with the entity that declares each piece (the result of ONE walk). */
export interface FlatChildShape<F = DeclaredField, R = DeclaredRelationship> {
	/** The base's name: the entity every `owner` below that is not the child itself resolves against. */
	base: string;
	/** Every flat field in order — the base's, less its discriminator, then the child's own — with its declaring entity. */
	fields: Array<{ name: string; field: F; owner: string }>;
	/** Every flat relationship in order — the base's, then the child's own — with its declaring entity. */
	relationships: Array<{ name: string; relationship: R; owner: string }>;
	/** The base's behaviours first, then the child's own, one per name. */
	behaviors: NonNullable<EntityDefinition['behaviors']>;
	/** The base's `tenant_scoped` (R5 keeps it off the child); `undefined` when the base declares none. */
	tenantScoped: TenantScopedDeclaration | undefined;
}

/**
 * The ONE walk of a joined-table child's flat shape (RFC-0006 §3.4, S7): the base's declared fields (less the
 * discriminator, which a sync never writes — the child's kind is fixed), then the child's own; the base's behaviours and
 * `tenant_scoped`, which R5 keeps off the child; the base's relationships under the child's. Each field and relationship
 * carries the entity that declares it, so a consumer that resolves against the declaring entity (a base enum, a base
 * foreign key) reads the owner here and never walks the family again. `null` when `def` is not a child, or its base is not
 * in `definitions` (the validator refuses that).
 *
 * R4 refuses a child field or relationship that shadows the base's, so the order cannot matter.
 */
export function flatChildShape<F, R>(
	def: FlatChildInput<F, R>,
	definitions: Iterable<FlatChildInput<F, R>>,
): FlatChildShape<F, R> | null {
	const decl = inheritsOf(def);
	if (decl === null) return null;
	const base = [...definitions].find((d) => d.entity.name === decl.base);
	if (base === undefined) return null;

	const fields: FlatChildShape<F, R>['fields'] = [];
	for (const [name, field] of Object.entries(base.fields ?? {})) {
		if (name !== base.discriminator) fields.push({ name, field, owner: base.entity.name });
	}
	for (const [name, field] of Object.entries(def.fields ?? {})) fields.push({ name, field, owner: def.entity.name });

	const relationships: FlatChildShape<F, R>['relationships'] = [];
	for (const [name, relationship] of Object.entries(base.relationships ?? {})) {
		relationships.push({ name, relationship, owner: base.entity.name });
	}
	for (const [name, relationship] of Object.entries(def.relationships ?? {})) {
		relationships.push({ name, relationship, owner: def.entity.name });
	}

	const seen = new Set<string>();
	const behaviors = [...(base.behaviors ?? []), ...(def.behaviors ?? [])].filter((b) => {
		const name = normalizeBehaviorConfig(b).name;
		if (seen.has(name)) return false;
		seen.add(name);
		return true;
	});

	return { base: base.entity.name, fields, relationships, behaviors, tenantScoped: base.tenant_scoped };
}

/**
 * A joined-table child as the plain entity a flat declaration of the same columns would parse to: no `inherits:` key
 * survives. The integration layer reads this, so a provider sync sees the same entity whether or not it sits in a family.
 * Not a child, or a child whose base is not in `definitions`, comes back unchanged. S7b and S7c both read it; the walk is
 * {@link flatChildShape}'s, and {@link flatChildOwners} is its other view.
 */
export function flattenInheritedChild<T extends FlatChildInput<F, R>, F = DeclaredField, R = DeclaredRelationship>(
	def: T,
	definitions: Iterable<FlatChildInput<F, R>>,
): T {
	const shape = flatChildShape(def, definitions);
	if (shape === null) return def;

	const { inherits: _inherits, ...own } = def;
	const fields = Object.fromEntries(shape.fields.map((f) => [f.name, f.field]));
	const relationships = Object.fromEntries(shape.relationships.map((r) => [r.name, r.relationship]));
	// `T` is the caller's entity type; the spread keeps every key it declares and replaces only the five the walk owns.
	return {
		...own,
		fields,
		behaviors: shape.behaviors,
		...(shape.tenantScoped !== undefined ? { tenant_scoped: shape.tenantScoped } : {}),
		...(Object.keys(relationships).length > 0 ? { relationships } : {}),
	} as unknown as T;
}

/**
 * Which entity declares each flat field and each flat relationship of a child — the other view of
 * {@link flatChildShape}. `null` when `def` is not a child (or its base is absent).
 */
export function flatChildOwners<F, R>(
	def: FlatChildInput<F, R>,
	definitions: Iterable<FlatChildInput<F, R>>,
): { base: string; fields: Record<string, string>; relationships: Record<string, string> } | null {
	const shape = flatChildShape(def, definitions);
	if (shape === null) return null;
	return {
		base: shape.base,
		fields: Object.fromEntries(shape.fields.map((f) => [f.name, f.owner])),
		relationships: Object.fromEntries(shape.relationships.map((r) => [r.name, r.owner])),
	};
}
