/**
 * `roles:` — derivation (CAP-2, ADR-041).
 *
 * A role is a named, typed edge from a communication-style entity to an actor
 * entity: `host`, `attendees`, `about`. A `cardinality: one` role **is** a
 * `belongs_to` with a name; this module is where that equivalence is written
 * down, once.
 *
 * It is deliberately dependency-free — no zod, no fs, no registry — because it
 * has two importers that share nothing else:
 *
 *   - `templates/entity/new/prompt.js`, which parses entity YAML **directly**
 *     (`yaml.parse`) and never sees `EntityDefinitionSchema`. A schema-level
 *     `.transform()` would therefore reach the analyzer and miss every template.
 *   - `src/parser/load-entities.ts`, which builds `ParsedEntity` from the
 *     validated definition.
 *
 * Writing the derivation in either place would make the other a second
 * implementation of the same rules (charter I1). Writing it here makes the FK
 * column, its nullability, its index and its on-delete action ride the existing
 * `belongs_to` path in both.
 *
 * See `docs/specs/CAP-2.md` §1–§3 and PLAN §6.3.
 */

import { junctionName } from '../config/junction-naming.js';

/** Name of the capability an entity must declare to be a role's `target`. */
export const ACTOR_CAPABILITY = 'Actor';

/** Name of the capability an entity must declare in order to have `roles:`. */
export const COMMUNICATION_CAPABILITY = 'Communication';

export type RoleCardinality = 'one' | 'many';

/** FK cascade action — the same vocabulary `relationships:` uses (ADR-021). */
export type RoleOnDelete = 'restrict' | 'cascade' | 'set_null' | 'no_action';

/**
 * One `roles:` entry, as authored. Kept verbatim on `ParsedEntity.roles` so
 * later units read the *declaration* rather than only its derived form.
 */
export interface RoleDefinition {
	/** Actor entity this role points at. */
	target: string;
	cardinality: RoleCardinality;
	/** `one` only — FK column override; default `<role>_<target>_id`. */
	column?: string;
	/** `many` only — the junction between this entity and the target. */
	via?: string;
	/**
	 * `one` only — FK nullability. Carried onto the derived relationship, where
	 * `processBelongsTo` gives it priority over the FK field's `required:` /
	 * `nullable:` — the same precedence a declared `belongs_to`'s `nullable:`
	 * has (no second rule). Unset: the field decides, else nullable.
	 */
	nullable?: boolean;
	/** `one` only — FK cascade action. Default `restrict`. */
	on_delete?: RoleOnDelete;
}

/**
 * A `belongs_to` relationship derived from a `cardinality: one` role.
 *
 * Shaped exactly like a hand-authored `relationships:` entry, plus two keys the
 * hand-authored form has no need for:
 *
 *   - `role` — the declaring role's name. It becomes the *relation key*, where
 *     a declared relationship's key comes from the target entity name. Two
 *     roles may point at one target (`host` and `organizer`, both `contact`);
 *     keying by target would emit one service method name twice and describe
 *     two graph edges with one name.
 *   - `index` — role edges are traversal paths, so the FK is indexed by
 *     default. An explicit field declaration still wins (see
 *     `processBelongsTo`).
 */
export interface DerivedRoleRelationship {
	type: 'belongs_to';
	target: string;
	foreign_key: string;
	on_delete: RoleOnDelete;
	nullable?: boolean;
	role: string;
	index: boolean;
}

/** Default FK column for a `one` role: `<role>_<target>_id`. */
export function roleForeignKey(
	role: string,
	target: string,
	column?: string,
): string {
	if (typeof column === 'string' && column.length > 0) return column;
	return `${role}_${target}_id`;
}

/**
 * Derive the `belongs_to` relationships a `roles:` block contributes, keyed by
 * role name.
 *
 * `cardinality: many` roles contribute nothing here on purpose: the junction
 * named by `via:` already owns that table, its two FKs and its edges. A role
 * *names* that junction; it never creates a second way to make one.
 */
export function deriveRoleRelationships(
	roles: Record<string, RoleDefinition> | undefined | null,
): Record<string, DerivedRoleRelationship> {
	const derived: Record<string, DerivedRoleRelationship> = {};
	if (!roles || typeof roles !== 'object') return derived;

	for (const [role, def] of Object.entries(roles)) {
		if (!def || def.cardinality !== 'one') continue;
		derived[role] = {
			type: 'belongs_to',
			target: def.target,
			foreign_key: roleForeignKey(role, def.target, def.column),
			on_delete: def.on_delete ?? 'restrict',
			...(def.nullable === undefined ? {} : { nullable: def.nullable }),
			role,
			index: true,
		};
	}

	return derived;
}

/**
 * Both junction names that could join `a` and `b`.
 *
 * A junction's name is `between[0]_between[1]` and has no YAML override, so a
 * `via:` that is neither of these cannot name a junction between the pair,
 * whatever files exist.
 */
export function junctionNamesFor(a: string, b: string): [string, string] {
	return [junctionName([a, b]), junctionName([b, a])];
}
