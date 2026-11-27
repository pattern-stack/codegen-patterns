/**
 * Does a value fit a field? The one rule behind a field's `example:` (validated against it when the YAML is
 * parsed) and behind the generated OpenAPI examples (`src/derived/examples/`), which use a declared `default:`
 * only when it fits — `default: now` on a datetime is a database expression, not a value a client sends.
 *
 * It mirrors what the generated Create DTO accepts for the field (`zodValueFor` + `zodLengthChecks` in
 * `templates/entity/new/backend/entity-locals.js`); the OpenAPI smoke gate parses every emitted example through
 * the real DTO, so a drift between the two fails there.
 */

/** Any 8-4-4-4-12 hex id — what the DTOs' `z.guid()` accepts. */
export const GUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The keys of a field this rule reads. */
export interface ExampleFieldShape {
	readonly type: string;
	readonly nullable: boolean;
	readonly choices?: readonly string[] | undefined;
	readonly minLength?: number | null;
	readonly maxLength?: number | null;
}

const ARRAY_ELEMENT: Record<string, string> = { string_array: 'string' };

function scalarFits(type: string, value: unknown, field: ExampleFieldShape): boolean {
	const choices = field.choices && field.choices.length > 0 ? field.choices : null;
	if (choices) return typeof value === 'string' && choices.includes(value);
	switch (type) {
		case 'string': {
			if (typeof value !== 'string') return false;
			if (field.minLength != null && value.length < field.minLength) return false;
			if (field.maxLength != null && value.length > field.maxLength) return false;
			return true;
		}
		case 'integer':
			return typeof value === 'number' && Number.isInteger(value);
		case 'decimal':
			return (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) || (typeof value === 'number' && Number.isFinite(value));
		case 'boolean':
			return typeof value === 'boolean';
		case 'uuid':
			return typeof value === 'string' && GUID_PATTERN.test(value);
		case 'date':
			return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
		case 'datetime':
			return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
		case 'json':
			return value !== undefined;
		default:
			// A type with no single-value DTO field (`entity_ref` expands to two columns) has no example.
			return false;
	}
}

/** `value` is one the field's Create DTO accepts. `null` fits a nullable field. */
export function valueFitsField(field: ExampleFieldShape, value: unknown): boolean {
	if (value === null) return field.nullable;
	const element = ARRAY_ELEMENT[field.type];
	if (element !== undefined) return Array.isArray(value) && value.every((v) => scalarFits(element, v, field));
	return scalarFits(field.type, value, field);
}

/** The author-facing message for an `example:` that does not fit its field. */
export function exampleMismatchMessage(type: string): string {
	return `'example' must be a value this field accepts (type: ${type}; an enum's example is one of its choices, a string's fits min_length/max_length)`;
}
