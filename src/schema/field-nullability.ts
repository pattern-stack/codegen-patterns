/**
 * Field nullability — the ONE statement of how a field's `required:` /
 * `nullable:` / `default:` declaration decides its column (#613, #736).
 *
 *   `required: true`                  → NOT NULL; must be provided on create.
 *   `nullable: true`                  → NULL allowed; optional on create.
 *   `nullable: false` + `default:`    → NOT NULL; optional on create — the
 *                                       database fills the default.
 *   `nullable: false`, no `default:`  → rejected (`notNullWithoutDefault`): the
 *                                       column is NOT NULL, so an insert that
 *                                       omits it fails. Say `required: true`.
 *   neither declared                  → NULL allowed; optional on create.
 *
 * A `belongs_to` FK column is the exception: it is NOT NULL unless `nullable:
 * true` says otherwise ({@link foreignKeyColumnNullable}, #850).
 *
 * `required: true, nullable: true` is rejected by `FieldDefinitionSchema`.
 *
 * "Neither declared" and "declared `nullable: false`" differ, so the schema
 * leaves `nullable` undefined when it is not written — a default of `false`
 * there made the two indistinguishable to every reader of the parsed model.
 *
 * Readers — every place that derives a column's nullability or a read type's
 * `| null` from a field declaration: the entity and relationship hygen prompts
 * (raw YAML, imported as `src/schema/field-nullability.js`), the parser
 * (`ParsedField.nullable`), REL-1's `belongsToOptional` and the integration
 * sink input. A reader that re-derives the rule inline is a second rule.
 *
 * Kept dependency-free: the hygen prompts import it straight from the shipped
 * `src/` tree (listed in `package.json` `files`).
 */

/** The three keys of a field declaration that decide its nullability. */
export interface FieldNullabilityDeclaration {
	required?: boolean | null;
	nullable?: boolean | null;
	default?: unknown;
}

/** True when the declaration carries a column default (`null` is no default). */
export function hasColumnDefault(field: FieldNullabilityDeclaration): boolean {
	return field.default !== undefined && field.default !== null;
}

/** Whether the field's column allows NULL — and so whether its read type is `T | null`. */
export function fieldColumnNullable(field: FieldNullabilityDeclaration): boolean {
	if (field.required === true) return false;
	if (field.nullable !== undefined && field.nullable !== null) return field.nullable;
	return true;
}

/**
 * Whether a `belongs_to`'s FK column allows NULL — THE foreign-key nullability
 * rule. A reference is NOT NULL unless something says it is optional (#850;
 * Rails 5's `belongs_to` precedent):
 *
 *   1. an explicit `nullable:` on the relationship (or the `cardinality: one`
 *      role that derives it) wins;
 *   2. else an explicit `nullable:` on the FK's own `fields:` entry;
 *   3. else NOT NULL.
 *
 * `required:` on the FK field does not decide it. `required: true` agrees with
 * the default; a written `required: false` without `nullable:` is rejected by
 * `EntityDefinitionSchema` ({@link FK_REQUIRED_FALSE_MESSAGE}), because before
 * #850 it meant "nullable" and would now silently mean NOT NULL.
 *
 * Readers: the entity template (column `.notNull()`, create/update DTO keys,
 * the integration sink's strict resolver), the parser (`ParsedField.nullable`,
 * which the semantic model reads), REL-1's `belongsToOptional` (the relations
 * manifest and the frontend graph that projects it) and the adapter view.
 */
export function foreignKeyColumnNullable(
	relationshipNullable: boolean | null | undefined,
	field: FieldNullabilityDeclaration | undefined,
): boolean {
	if (relationshipNullable !== undefined && relationshipNullable !== null) {
		return relationshipNullable;
	}
	if (field?.nullable !== undefined && field.nullable !== null) return field.nullable;
	return false;
}

/**
 * True when an FK field writes `required: false` without `nullable:` — the
 * pre-#850 spelling of an optional reference, which the NOT NULL default would
 * otherwise turn into a NOT NULL column without a word. Needs the field as
 * WRITTEN: `FieldDefinitionSchema` leaves `required` undefined when absent.
 */
export function foreignKeyRequiredFalseWithoutNullable(
	field: FieldNullabilityDeclaration | undefined,
): boolean {
	return field?.required === false && (field.nullable === undefined || field.nullable === null);
}

/** The message for {@link foreignKeyRequiredFalseWithoutNullable}. */
export const FK_REQUIRED_FALSE_MESSAGE =
	"'required: false' does not make a belongs_to foreign key nullable: a reference is NOT NULL unless it " +
	"says otherwise. Write 'nullable: true' (on the field or the relationship) for an optional reference, " +
	"or drop 'required: false' for a NOT NULL one.";

/**
 * True for the one declaration that cannot be generated: a NOT NULL column
 * (`nullable: false`) that is optional on create (`required` not `true`) and
 * has no `default:`. Every insert that omits it would fail at the database.
 */
export function notNullWithoutDefault(field: FieldNullabilityDeclaration): boolean {
	return field.nullable === false && field.required !== true && !hasColumnDefault(field);
}

/** The message for {@link notNullWithoutDefault}, shared by every place that refuses it. */
export const NOT_NULL_WITHOUT_DEFAULT_MESSAGE =
	"'nullable: false' without 'required: true' needs a 'default:'. The column is NOT NULL, so an insert " +
	"that omits it fails. Declare 'required: true' (must be provided on create) or add a 'default:' " +
	'(optional on create; the database fills it).';
