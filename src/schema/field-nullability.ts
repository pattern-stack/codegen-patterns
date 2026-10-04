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
 * Whether a `belongs_to`'s FK column allows NULL. An explicit `nullable:` on
 * the relationship (or the role that derives it) wins; else the FK column's own
 * `fields:` declaration decides, by {@link fieldColumnNullable}; else the FK is
 * nullable.
 */
export function foreignKeyColumnNullable(
	relationshipNullable: boolean | null | undefined,
	field: FieldNullabilityDeclaration | undefined,
): boolean {
	if (relationshipNullable !== undefined && relationshipNullable !== null) {
		return relationshipNullable;
	}
	return field ? fieldColumnNullable(field) : true;
}

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
