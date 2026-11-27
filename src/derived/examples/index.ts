/**
 * The OpenAPI examples of an entity's DTOs — what Swagger's "Try it out" prefills (ADR-046's derived layer: the
 * templates print these values; nothing in a template decides one).
 *
 * A field's example, in order: its YAML `example:`; else its `default:` when that is a value the DTO accepts
 * (`default: now` is a database expression, not one); else its first choice; else a clean value made from its type
 * and name (`name` → `'Example name'`). The rule for "a value the DTO accepts" is `valueFitsField`
 * (`src/schema/field-example.ts`), the one the YAML's `example:` is validated with.
 *
 * - **Create**: every field the body must carry (required, or a NOT NULL foreign key), every field with a default
 *   (the prefill shows it) and every field with a declared `example:`. An optional field without either stays out,
 *   so a prefilled request sends nothing the author did not choose.
 * - **Update**: a minimal PATCH — the first field, and the first enum or boolean after it — never the whole body.
 * - **Output**: every column, so the response sample is the row's whole shape.
 *
 * A foreign key's example is a placeholder id: no example can name a row that exists. The FK's description says so
 * (`foreignKeyDescription`), and the value stays a valid guid so the request parses.
 */
import { GUID_PATTERN, valueFitsField } from '../../schema/field-example.js';

/** A valid, recognisably placeholder id. */
export const EXAMPLE_GUID = '00000000-0000-4000-8000-000000000001';
/** A fixed date and instant, so examples (and the goldens that print them) never change from run to run. */
export const EXAMPLE_DATE = '2026-01-15';
export const EXAMPLE_DATETIME = '2026-01-15T09:30:00.000Z';

/** The facts of a field this derivation reads (a subset of `FieldFacts`, `src/derived/columns/types.ts`). */
export interface ExampleField {
	readonly name: string;
	readonly camelName: string;
	readonly type: string;
	readonly nullable: boolean;
	readonly required: boolean;
	readonly hasDefault: boolean;
	readonly default: unknown;
	readonly example: unknown;
	readonly choices?: readonly string[] | undefined;
	readonly minLength?: number | null;
	readonly maxLength?: number | null;
}

/** A `belongs_to`'s foreign key as the DTOs carry it. */
export interface ExampleForeignKey {
	readonly camelName: string;
	readonly nullable: boolean;
}

/** `first_name` → `'Example first name'`, fitted to the field's length bounds. */
function stringFromName(field: ExampleField): string {
	let value = `Example ${field.name.replace(/_/g, ' ')}`;
	if (field.maxLength != null && value.length > field.maxLength) value = value.slice(0, field.maxLength);
	if (field.minLength != null) while (value.length < field.minLength) value += 'x';
	return value;
}

function valueByType(field: ExampleField): unknown {
	const first = field.choices && field.choices.length > 0 ? field.choices[0] : undefined;
	switch (field.type) {
		case 'string':
			return first ?? stringFromName(field);
		case 'enum':
			return first;
		case 'integer':
			return 1;
		case 'decimal':
			return '10.00';
		case 'boolean':
			return true;
		case 'uuid':
			return EXAMPLE_GUID;
		case 'date':
			return EXAMPLE_DATE;
		case 'datetime':
			return EXAMPLE_DATETIME;
		case 'json':
			return {};
		case 'string_array':
			return [first ?? 'example'];
		default:
			return undefined;
	}
}

/**
 * A field's example: its `example:`, else a fitting `default:`, else its first choice, else a value by type.
 * `undefined` for a type with no single-value DTO field. Throws on an `example:` that does not fit — reached only by
 * a `choices_of:` field, whose choices the YAML schema could not see.
 */
export function fieldExample(field: ExampleField): unknown {
	if (field.example !== undefined) {
		if (!valueFitsField(field, field.example)) {
			throw new Error(
				`[codegen] field '${field.name}': example ${JSON.stringify(field.example)} is not a value it accepts` +
					(field.choices ? ` (one of: ${field.choices.join(', ')})` : ''),
			);
		}
		return field.example;
	}
	if (field.hasDefault && valueFitsField(field, field.default)) return field.default;
	if (field.choices && field.choices.length > 0) {
		return field.type === 'string_array' ? [field.choices[0]] : field.choices[0];
	}
	const byType = valueByType(field);
	return byType !== undefined && valueFitsField(field, byType) ? byType : undefined;
}

function put(out: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) out[key] = value;
}

/** The Create body: what it must carry, plus each default and declared example (see the module comment). */
export function createExample(
	fields: readonly ExampleField[],
	foreignKeys: readonly ExampleForeignKey[],
	overrides: Readonly<Record<string, unknown>> = {},
	omit: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const fk of foreignKeys) if (!fk.nullable) out[fk.camelName] = EXAMPLE_GUID;
	for (const f of fields) {
		if (omit.has(f.camelName)) continue;
		if (f.camelName in overrides) {
			put(out, f.camelName, overrides[f.camelName]);
			continue;
		}
		if (f.required || f.hasDefault || f.example !== undefined) put(out, f.camelName, fieldExample(f));
	}
	return out;
}

/**
 * A minimal PATCH: the first field, plus the first enum or boolean after it. Empty when the entity has no field of
 * its own (a child then shows its base's update example).
 */
export function updateExample(
	fields: readonly ExampleField[],
	omit: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
	const usable = fields.filter((f) => !omit.has(f.camelName) && fieldExample(f) !== undefined);
	const out: Record<string, unknown> = {};
	const first = usable[0];
	if (!first) return out;
	out[first.camelName] = fieldExample(first);
	const second = usable.slice(1).find((f) => f.type === 'boolean' || (f.choices && f.choices.length > 0));
	if (second) out[second.camelName] = fieldExample(second);
	return out;
}

/** Behaviour columns an output carries. */
export interface ExampleOutputExtras {
	readonly id?: boolean;
	readonly externalId?: boolean;
	readonly timestamps?: boolean;
	readonly softDelete?: boolean;
}

/** The output row: id, every foreign key, every field, and the behaviour columns it declares. */
export function outputExample(
	fields: readonly ExampleField[],
	foreignKeys: readonly ExampleForeignKey[],
	extras: ExampleOutputExtras,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (extras.id !== false) out.id = EXAMPLE_GUID;
	for (const fk of foreignKeys) out[fk.camelName] = EXAMPLE_GUID;
	for (const f of fields) {
		const value = fieldExample(f);
		put(out, f.camelName, value === undefined && f.nullable ? null : value);
	}
	if (extras.externalId) out.externalId = null;
	if (extras.timestamps) {
		out.createdAt = EXAMPLE_DATETIME;
		out.updatedAt = EXAMPLE_DATETIME;
	}
	if (extras.softDelete) out.deletedAt = null;
	return out;
}

/** The description a foreign key carries in the API docs: the example id is a placeholder. */
export function foreignKeyDescription(targetEntity: string, targetListPath: string): string {
	return (
		`The id of an existing ${targetEntity} (GET ${targetListPath} lists them). ` +
		`The example is a placeholder: replace it with a real id before sending.`
	);
}

/** The description an `:id` path parameter carries: the same placeholder caveat. */
export function idParamDescription(entity: string, listPath: string): string {
	return (
		`The ${entity}'s id (from a create or GET ${listPath} response). ` +
		`The example is a placeholder: replace it with a real id before sending.`
	);
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function stringLiteral(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/**
 * The entries of an object literal, `key: value, …`, in the emitted code's style (single quotes, bare keys where a
 * key is an identifier). For a child's example, which spreads its base's before its own.
 */
export function exampleEntries(value: Readonly<Record<string, unknown>>): string {
	return Object.entries(value)
		.map(([k, v]) => `${IDENTIFIER.test(k) ? k : stringLiteral(k)}: ${exampleLiteral(v)}`)
		.join(', ');
}

/** A value as a TypeScript expression the templates print (`{ name: 'Example name', isOpen: true }`). */
export function exampleLiteral(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'string') return stringLiteral(value);
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return `[${value.map(exampleLiteral).join(', ')}]`;
	if (typeof value === 'object') {
		const entries = exampleEntries(value as Record<string, unknown>);
		return entries === '' ? '{}' : `{ ${entries} }`;
	}
	throw new Error(`[codegen] an example value must be JSON, got ${typeof value}`);
}

/** `value` is a guid — exported for the gates that check an id example. */
export function isGuid(value: unknown): boolean {
	return typeof value === 'string' && GUID_PATTERN.test(value);
}
