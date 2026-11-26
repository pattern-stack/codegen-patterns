/**
 * The derived column facts — what a declared field IS, before any target renders it (TGT-0, ADR-046's `columns/`
 * slot, ADR-047).
 *
 * Types only: zero runtime imports.
 *
 * Deliberately NOT here: source text of any kind — no column builder (`varchar('x', …)`), no Zod chain, no TypeScript
 * type string, no SQL. A fact is a value a renderer reads; `deriveFieldFacts`' test asserts none is builder text.
 * The renderer that turns facts into a target's text is `src/targets/<target>/columns.ts`.
 */

/** Where a `choices_of:` enum is declared, when it is another entity's (RFC-0006 §2.4). */
export interface ImportedEnum {
	/** The owner's exported enum name. */
	readonly enumName: string;
	/** The owner's `.enums` leaf module, as seen from the reading entity's folder. */
	readonly importPath: string;
}

/** One declared field of an entity (or a junction's payload), as facts. The field `id` is never one. */
export interface FieldFacts {
	/** The YAML field name, snake_case — also the column name. */
	readonly name: string;
	/** The TypeScript property name. */
	readonly camelName: string;
	/** The YAML `type:` (`string` when absent). */
	readonly type: string;
	/** The element type of an array type (`string_array` → `string`); the type itself otherwise. */
	readonly elementType: string;
	/** True for an array type (`string_array`). */
	readonly isArray: boolean;
	/** The column accepts NULL — the one nullability rule (`src/schema/field-nullability.ts`, #736). */
	readonly nullable: boolean;
	/** `required: true` — the create payload must carry it. */
	readonly required: boolean;
	/** The column has a database default (`default:` declared). */
	readonly hasDefault: boolean;
	/** The declared `default:` value, verbatim; `undefined` when there is none. */
	readonly default: unknown;
	/** A `datetime` keeps its time zone (#796, `src/schema/field-timestamp.ts`); `null` for any other type. */
	readonly withTimezone: boolean | null;
	/** The enum's values — the field's own `choices:`, or its `choices_of:` owner's. */
	readonly choices: readonly string[] | undefined;
	/** The field is an enum (non-empty `choices`). */
	readonly hasChoices: boolean;
	/** The enum's exported name (`fieldConfigRoleEnum`); `null` when not an enum. */
	readonly enumName: string | null;
	/** The enum's database type name (`field_config_role`); `null` when not an enum. */
	readonly enumDbName: string | null;
	/** Set when the enum is another entity's (`choices_of:`): imported, never redeclared. */
	readonly enumImport: ImportedEnum | null;
	/** `min_length` on a string field (#772); `null` otherwise. */
	readonly minLength: number | null;
	/** `max_length` on a string field (#772); `null` otherwise. */
	readonly maxLength: number | null;
}

/**
 * Resolves a `choices_of:` field's enum (`resolveEnumField` in `templates/_shared/inheritance.mjs`): the owner's
 * choices, names and import path. `null` when the field is not an enum.
 */
export type EnumResolver = (
	fieldName: string,
	field: Readonly<Record<string, unknown>>,
) => { choices: readonly string[]; enumName: string; dbName: string; importPath: string } | null;
