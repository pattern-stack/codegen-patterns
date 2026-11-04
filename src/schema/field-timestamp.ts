/**
 * Field timestamps — the ONE statement of how a field's `type:` / `timezone:`
 * declaration decides its timestamp column (#796).
 *
 *   `type: datetime`                  → `timestamp with time zone` (timestamptz).
 *   `type: datetime, timezone: false` → `timestamp without time zone`: a
 *                                       wall-clock time, read through the
 *                                       `Date`'s UTC fields.
 *   `timezone:` on any other type     → rejected (`timezoneOnNonDatetime`).
 *
 * The behavior columns (`created_at`, `updated_at`, `deleted_at`) and the
 * junction / relationship template time columns are always timestamptz.
 *
 * Readers: the schema, and the entity, junction and relationship hygen prompts
 * (imported as `src/schema/field-timestamp.js`). Nothing else spells the
 * options literal.
 *
 * Kept dependency-free: the hygen prompts import it straight from the shipped
 * `src/` tree.
 */

/** The two keys of a field declaration that decide its timestamp column. */
export interface FieldTimestampDeclaration {
	type?: string | null;
	timezone?: boolean | null;
}

/** A `datetime` column is timestamptz unless the field says `timezone: false`. */
export function fieldWithTimezone(field: FieldTimestampDeclaration): boolean {
	return field.type === 'datetime' && field.timezone !== false;
}

/** `timezone:` declared (true or false) on anything but `type: datetime`. */
export function timezoneOnNonDatetime(field: FieldTimestampDeclaration): boolean {
	return field.timezone !== undefined && field.timezone !== null && field.type !== 'datetime';
}

/** `timezone:` declared as anything but a boolean (`"no"`, `0`). Junction / relationship fields are not Zod-parsed. */
export function timezoneNotBoolean(field: { timezone?: unknown }): boolean {
	return field.timezone !== undefined && field.timezone !== null && typeof field.timezone !== 'boolean';
}

export const TIMEZONE_NOT_BOOLEAN_MESSAGE = "'timezone' must be true or false.";

/** Shared by the schema refine and the junction / relationship prompt throws. */
export const TIMEZONE_ON_NON_DATETIME_MESSAGE =
	"'timezone' can only be used with type 'datetime'. A datetime column is timestamp with time zone; " +
	"'timezone: false' makes it a wall-clock timestamp without time zone.";

/** The Drizzle builder call for a timestamp column. The only place the options literal is written. */
export function timestampColumn(column: string, withTimezone = true): string {
	return withTimezone
		? `timestamp('${column}', { withTimezone: true, mode: 'date' })`
		: `timestamp('${column}')`;
}
