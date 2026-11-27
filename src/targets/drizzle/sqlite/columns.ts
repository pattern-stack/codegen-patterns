/**
 * The `drizzle` + `sqlite` column renderer (TGT-2a, ADR-047): column facts → a Drizzle `sqlite-core` column builder,
 * the builder's import name, and the TypeScript type Drizzle's select model gives the column.
 *
 * SQLite storage per kind (G3's storage half; the spike in `sqlite-proxy-roundtrip.test.ts` holds each one):
 * - `string` / `uuid` / `date` / `instant` / `decimal` → TEXT. An instant is ISO 8601 (UTC with `Z`; wall-clock
 *   without an offset when `timezone: false`); a decimal is TEXT because NUMERIC affinity drops its scale.
 * - `integer` → INTEGER; `boolean` → INTEGER 0/1 (`mode: 'boolean'`).
 * - `json` and arrays → TEXT (`mode: 'json'`); SQLite has no array type.
 * - `enum` → TEXT typed by its choices (`{ enum: [...] }`); the database CHECK is the constraint renderer's.
 * - A `max_length` is a length hint here; SQLite ignores it, so the constraint renderer adds a CHECK.
 * - The `id` is TEXT NOT NULL (SQLite lets a non-INTEGER primary key be NULL), made by the application
 *   (`globalThis.crypto.randomUUID()`): SQLite has no uuid function.
 *
 * Not yet registered: `TARGET_PAIRS` gains `{ database: sqlite, orm: drizzle }` in TGT-2b, with the templates that
 * print this text. Hygen-safe: imports only shipped modules.
 */

import type { FieldFacts } from '../../../derived/columns/types.js';
import { fieldColumn } from '../../../derived/tables/columns.js';
import type { ColumnFact } from '../../../derived/tables/types.js';
import type { ColumnRenderer, RenderedColumn } from '../../columns.js';

/** The `drizzle-orm/sqlite-core` import each builder needs. */
const IMPORTS: Readonly<Record<string, string>> = { text: 'text', integer: 'integer' };

/** SQLite's current instant / date, as SQL, matching what the DDL renderer writes. */
export function sqliteNow(kind: 'instant' | 'date', withTimezone: boolean | null): string {
	if (kind === 'date') return "(date('now'))";
	return withTimezone === false ? "(strftime('%Y-%m-%dT%H:%M:%f', 'now'))" : "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
}

function quote(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** The builder call, before nullability and default. */
function builder(c: ColumnFact): { drizzleType: string; chain: string } {
	const name = quote(c.name);
	if (c.isArray) {
		const element = c.kind === 'enum' ? `(${(c.choices ?? []).map(quote).join(' | ')})` : tsElement(c);
		return { drizzleType: 'text', chain: `text(${name}, { mode: 'json' }).$type<${element}[]>()` };
	}
	switch (c.kind) {
		case 'integer':
			return { drizzleType: 'integer', chain: `integer(${name})` };
		case 'boolean':
			return { drizzleType: 'integer', chain: `integer(${name}, { mode: 'boolean' })` };
		case 'json':
			return { drizzleType: 'text', chain: `text(${name}, { mode: 'json' })` };
		case 'enum':
			return { drizzleType: 'text', chain: `text(${name}, { enum: [${(c.choices ?? []).map(quote).join(', ')}] })` };
		case 'string':
			return { drizzleType: 'text', chain: c.maxLength !== null ? `text(${name}, { length: ${c.maxLength} })` : `text(${name})` };
		default:
			// uuid, date, instant, decimal: TEXT.
			return { drizzleType: 'text', chain: `text(${name})` };
	}
}

function tsElement(c: ColumnFact): string {
	switch (c.kind) {
		case 'integer':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'json':
			return 'unknown';
		case 'enum':
			return (c.choices ?? []).map(quote).join(' | ');
		default:
			return 'string';
	}
}

function defaultOf(c: ColumnFact): string {
	if (c.default === null) return '';
	if ('now' in c.default) {
		const kind = c.kind === 'date' ? 'date' : 'instant';
		return `.default(sql\`${sqliteNow(kind, c.withTimezone)}\`)`;
	}
	const v = c.default.value;
	if (c.kind === 'json' || c.isArray) return `.default(${JSON.stringify(v)})`;
	// A decimal is TEXT, so its default is a string even when the YAML wrote a number (as Postgres numeric quotes it).
	if (c.kind !== 'decimal' && (typeof v === 'boolean' || typeof v === 'number')) return `.default(${v})`;
	return `.default(${quote(String(v))})`;
}

/** A column fact's whole Drizzle chain. */
export function renderSqliteColumn(c: ColumnFact): RenderedColumn {
	const { drizzleType, chain } = builder(c);
	let out = chain;
	if (c.origin === 'id') {
		// NOT NULL too: a non-INTEGER primary key in a (non-STRICT) SQLite table otherwise accepts NULL, more than once.
		out += '.primaryKey().notNull()';
		if (c.generatedId) out += '.$defaultFn(() => globalThis.crypto.randomUUID())';
	} else if (!c.nullable) {
		out += '.notNull()';
	}
	out += defaultOf(c);
	const element = tsElement(c);
	return { drizzleType, drizzleChain: out, tsType: c.isArray ? `(${element})[]` : element };
}

export const drizzleSqliteColumns: ColumnRenderer = {
	pair: 'drizzle/sqlite',
	render(f: FieldFacts): RenderedColumn {
		return renderSqliteColumn(fieldColumn(f));
	},
	importFor(drizzleType: string): string | undefined {
		return IMPORTS[drizzleType];
	},
	/** The behavior / junction time columns: ISO TEXT, whatever the zone (the zone shapes only the default). */
	timestampColumn(column: string, withTimezone: boolean): string {
		if (typeof withTimezone !== 'boolean') {
			throw new Error(`timestampColumn('${column}'): withTimezone must be true or false, got ${String(withTimezone)}.`);
		}
		return `text(${quote(column)})`;
	},
};
