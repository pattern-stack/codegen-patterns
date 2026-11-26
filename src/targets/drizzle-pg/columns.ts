/**
 * The `drizzle-pg` column renderer (TGT-0, ADR-047): {@link FieldFacts} → a Drizzle `pg-core` column builder, the
 * builder's import name, and the TypeScript type Drizzle's select model gives the column.
 *
 * Every string here is Drizzle-on-Postgres text; the facts it reads hold none. Moved verbatim from
 * `templates/entity/new/backend/entity-locals.js` — the bytes it renders are the bytes the goldens pin.
 *
 * Hygen-safe: reached from `entity-locals.js`, so it imports only modules that ship in the package's `files`.
 */

import type { FieldFacts } from '../../derived/columns/types.js';
import { timestampColumn } from '../../schema/field-timestamp.js';
import type { ColumnRenderer, RenderedColumn } from '../columns.js';

/** A field's element type → its Drizzle column builder. */
const DRIZZLE_TYPE_MAP: Readonly<Record<string, string>> = {
	string: 'text',
	integer: 'integer',
	decimal: 'numeric',
	boolean: 'boolean',
	uuid: 'uuid',
	date: 'date',
	datetime: 'timestamp',
	json: 'jsonb',
};

/** The `drizzle-orm/pg-core` import each builder needs. An `enum` column calls its `pgEnum` and needs none. */
export const DRIZZLE_IMPORT_MAP: Readonly<Record<string, string>> = {
	text: 'text',
	integer: 'integer',
	numeric: 'numeric',
	boolean: 'boolean',
	uuid: 'uuid',
	date: 'date',
	timestamp: 'timestamp',
	jsonb: 'jsonb',
	varchar: 'varchar',
};

/**
 * A field's element type → the TypeScript type Drizzle's select model gives its column. `decimal` is `string`: pg
 * `numeric` comes back as a string (precision preservation). `date` is `Date` because the builder is written with
 * `mode: 'date'` (`buildDrizzleChain`).
 */
const TS_TYPE_MAP: Readonly<Record<string, string>> = {
	string: 'string',
	integer: 'number',
	decimal: 'string',
	boolean: 'boolean',
	uuid: 'string',
	date: 'Date',
	datetime: 'Date',
	json: 'unknown',
};

/** The `varchar(n)` column a `max_length` string field is (#772). */
export function varcharColumn(fieldName: string, maxLength: number | null): string {
	return `varchar('${fieldName}', { length: ${maxLength} })`;
}

/** A single-quoted, escaped TS string literal. */
function quoteLiteral(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Render a Drizzle `.default(...)` (or `.defaultNow()`) suffix for a column.
 *
 * - timestamp/date + a `now`/`now()`/`current_timestamp` sentinel → `.defaultNow()`
 * - numeric (Drizzle returns it as a string) → quoted, even for numeric YAML values
 * - string / enum literal → single-quoted, escaped
 * - number / boolean → bare literal
 * - array of strings (an array column) → array of single-quoted literals
 * - anything else (jsonb object/array default) → JSON literal
 */
export function renderColumnDefault(value: unknown, drizzleType: string): string {
	if (
		(drizzleType === 'timestamp' || drizzleType === 'date') &&
		typeof value === 'string' &&
		/^(now|now\(\)|current_timestamp)$/i.test(value)
	) {
		return '.defaultNow()';
	}
	if (drizzleType === 'numeric') {
		return `.default('${String(value)}')`;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return `.default(${value})`;
	}
	if (typeof value === 'string') {
		return `.default(${quoteLiteral(value)})`;
	}
	// An array column's default (#281): its elements as literals, the way a
	// scalar default renders — `.default(['email'])`.
	if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
		return `.default([${value.map(quoteLiteral).join(', ')}])`;
	}
	return `.default(${JSON.stringify(value)})`;
}

/** The builder a field's column calls: its enum, `varchar` for a bounded string, else by element type. */
function drizzleTypeOf(f: FieldFacts): string {
	if (f.hasChoices) return 'enum';
	if (f.maxLength !== null) return 'varchar';
	return DRIZZLE_TYPE_MAP[f.elementType] || 'text';
}

/** A Drizzle column chain for a field. */
function buildDrizzleChain(f: FieldFacts, drizzleType: string): string {
	// Drizzle's `date('x')` returns the PgDateString builder by default
	// (data type: string). Force the Date-typed variant so DTO Zod
	// schemas using z.coerce.date() align with the entity type.
	// `datetime` is timestamptz unless `timezone: false` (#796, `field-timestamp.ts`);
	// its `mode: 'date'` is written out so the TS type does not lean on Drizzle's default.
	let chain: string;
	if (drizzleType === 'enum' && f.enumName) {
		// Reference the pgEnum declaration emitted in the entity's `.enums` module.
		// The column name argument keeps the snake_case YAML field name.
		chain = `${f.enumName}('${f.name}')`;
	} else if (drizzleType === 'varchar') {
		chain = varcharColumn(f.name, f.maxLength);
	} else if (drizzleType === 'date') {
		chain = `${drizzleType}('${f.name}', { mode: 'date' })`;
	} else if (f.type === 'datetime') {
		chain = timestampColumn(f.name, f.withTimezone === true);
	} else {
		chain = `${drizzleType}('${f.name}')`;
	}
	// An array type is a Postgres array of its element column (#281).
	if (f.isArray) {
		chain += '.array()';
	}

	// NOT NULL by the one nullability rule (`field-nullability.ts`, #736):
	// `required: true`, or `nullable: false` (which the schema only accepts
	// with a `default:`, rendered below).
	if (!f.nullable) {
		chain += '.notNull()';
	}

	// Column defaults (#345). The value is validated upstream (schema `default:`).
	// Covers every scalar type, enum literals, and the `now` sentinel on
	// timestamp/date columns — not just booleans.
	if (f.hasDefault) {
		chain += renderColumnDefault(f.default, drizzleType);
	}

	return chain;
}

/** The TypeScript type of a field's column in Drizzle's select model. */
function tsTypeOf(f: FieldFacts): string {
	const elementTsType = f.hasChoices
		? (f.choices ?? []).map((c) => `'${c}'`).join(' | ')
		: TS_TYPE_MAP[f.elementType] || 'unknown';
	if (!f.isArray) return elementTsType;
	return f.hasChoices ? `(${elementTsType})[]` : `${elementTsType}[]`;
}

export const drizzlePgColumns: ColumnRenderer = {
	id: 'drizzle-pg',
	render(f: FieldFacts): RenderedColumn {
		const drizzleType = drizzleTypeOf(f);
		return { drizzleType, drizzleChain: buildDrizzleChain(f, drizzleType), tsType: tsTypeOf(f) };
	},
};
