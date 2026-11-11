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
 * Behavior columns (`created_at` / `updated_at` from `timestamps`, `deleted_at`
 * from `soft_delete`) are timestamptz unless switched off (#796 follow-up,
 * #845) — {@link behaviorWithTimezone}:
 *   1. the behavior's own `options: { timezone: false }` in the entity's
 *      `behaviors:` list, else
 *   2. the project's `behaviors.timezone` in `codegen.config.yaml` (default
 *      `true`).
 * Off is for adopting a host whose columns are `timestamp without time zone`
 * holding UTC: Drizzle reads a naive value as UTC only when the column is
 * declared naive; declared `withTimezone` it parses the offset-less string in
 * the PROCESS zone (a 4 h skew measured in America/New_York).
 *
 * The junction / relationship template time columns are always timestamptz.
 *
 * Readers: the entity schema (option validation), and the entity, junction and
 * relationship hygen prompts (imported as `src/schema/field-timestamp.js`).
 * Nothing else spells the options literal.
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

/** A `behaviors:` entry as declared: a name, or `{ name, options }`. */
export type BehaviorDeclaration = string | { name: string; options?: Record<string, unknown> | null };

/**
 * Whether `behavior`'s timestamp columns are timestamptz: the entity's own
 * `options.timezone` on that behavior, else the project default
 * (`behaviors.timezone`). An implied behavior (from a pattern) has no entry and
 * takes the project default.
 */
export function behaviorWithTimezone(
	behaviors: readonly BehaviorDeclaration[] | null | undefined,
	behavior: string,
	projectDefault: boolean,
): boolean {
	for (const b of behaviors ?? []) {
		if (typeof b === 'string' || b.name !== behavior) continue;
		const tz = b.options?.timezone;
		if (typeof tz === 'boolean') return tz;
	}
	return projectDefault;
}

/**
 * The error for a `timezone` behavior option, or `null` when it is fine: it must
 * be a boolean, on a behavior that emits a timestamp column. `timestampBehaviors`
 * comes from the behavior registry (`timestampBehaviorNames()`), so this module
 * keeps no list of its own.
 */
export function behaviorTimezoneOptionError(
	declaration: BehaviorDeclaration,
	timestampBehaviors: readonly string[],
): string | null {
	if (typeof declaration === 'string') return null;
	const tz = declaration.options?.timezone;
	if (tz === undefined) return null;
	if (!timestampBehaviors.includes(declaration.name)) {
		return (
			`'timezone' is an option of the behaviors that emit a timestamp column (${timestampBehaviors.join(', ')}); ` +
			`'${declaration.name}' emits none.`
		);
	}
	if (typeof tz !== 'boolean') return TIMEZONE_NOT_BOOLEAN_MESSAGE;
	return null;
}

/** The Drizzle builder call for a timestamp column. The only place the options literal is written. */
export function timestampColumn(column: string, withTimezone = true): string {
	return withTimezone
		? `timestamp('${column}', { withTimezone: true, mode: 'date' })`
		: `timestamp('${column}')`;
}
