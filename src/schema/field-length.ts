/**
 * Field length keys — the ONE statement of when `min_length` / `max_length`
 * are accepted on a field declaration (#772). What they emit (a `varchar(n)`
 * column, `.min(n)` / `.max(n)` on the write DTOs) is `stringLengthBounds` in
 * `templates/entity/new/backend/entity-locals.js`; this module only decides
 * whether the declaration is valid.
 *
 *   - either key next to `choices:` / `choices_from:` → refused, whatever the
 *     type: an enum's values bound its length, so the key would be parsed and
 *     ignored (the #690 silent-drop class);
 *   - either key on any other type than `string` → refused;
 *   - `min_length` greater than `max_length` → refused: nothing satisfies both.
 *
 * Readers: `FieldDefinitionSchema` (entity fields and junction payload fields)
 * and the relationship hygen prompt, whose `fields:` the relationship schema
 * does not parse. Each reports an issue against the field it is validating.
 *
 * Kept dependency-free: the hygen prompts import it straight from the shipped
 * `src/` tree (listed in `package.json` `files`).
 */

export type FieldLengthKey = 'min_length' | 'max_length';

/** The keys of a field declaration this rule reads. */
export interface FieldLengthDeclaration {
	type?: unknown;
	min_length?: unknown;
	max_length?: unknown;
	choices?: unknown;
	choices_from?: unknown;
}

export interface FieldLengthIssue {
	/** The offending key — the issue's path within the field. */
	key: FieldLengthKey;
	message: string;
}

const LENGTH_KEYS: readonly FieldLengthKey[] = ['min_length', 'max_length'];

/** Every reason the declaration's length keys are invalid; empty when they are fine. */
export function fieldLengthIssues(field: FieldLengthDeclaration): FieldLengthIssue[] {
	const issues: FieldLengthIssue[] = [];
	const enumKey =
		field.choices !== undefined ? 'choices' : field.choices_from !== undefined ? 'choices_from' : null;
	for (const key of LENGTH_KEYS) {
		if (field[key] === undefined) continue;
		// The enum refusal first: `type: enum` + `choices:` + a length key is an
		// enum mistake, not a type mistake.
		if (enumKey !== null) {
			issues.push({
				key,
				message: `'${key}' does not apply to an enum field ('${enumKey}:'): its values bound its length — remove '${key}'`,
			});
		} else if (field.type !== 'string') {
			issues.push({ key, message: `'${key}' can only be used with type 'string'` });
		}
	}
	if (
		typeof field.min_length === 'number' &&
		typeof field.max_length === 'number' &&
		field.min_length > field.max_length
	) {
		issues.push({ key: 'min_length', message: "'min_length' cannot exceed 'max_length': no value could satisfy both" });
	}
	return issues;
}
