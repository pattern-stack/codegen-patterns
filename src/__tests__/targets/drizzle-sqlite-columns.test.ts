/**
 * TGT-2a: the drizzle/sqlite column renderer's exact text per storage kind, nullability, default and the id — the
 * sqlite-core builders the spike (`sqlite-proxy-roundtrip.test.ts`) proved round-trip.
 */

import { describe, expect, it } from 'bun:test';
import { deriveFieldFacts } from '../../derived/columns/fields';
import { deriveTableColumns } from '../../derived/tables/columns';
import { drizzleSqliteColumns as sqlite, renderSqliteColumn } from '../../targets/drizzle/sqlite/columns';

const render = (field: Record<string, unknown>) => sqlite.render(deriveFieldFacts({ x: field }, 'note', null)[0]!);

// A field with a `default:` and no `required:` stays nullable (the one nullability rule, #736), as on Postgres.
describe('drizzle/sqlite columns', () => {
	it.each([
		[{ type: 'string' }, "text('x')", 'string'],
		[{ type: 'string', max_length: 80, required: true }, "text('x', { length: 80 }).notNull()", 'string'],
		[{ type: 'integer' }, "integer('x')", 'number'],
		[{ type: 'decimal' }, "text('x')", 'string'],
		[{ type: 'boolean', default: true }, "integer('x', { mode: 'boolean' }).default(true)", 'boolean'],
		[{ type: 'uuid' }, "text('x')", 'string'],
		[{ type: 'date', default: 'now' }, "text('x').default(sql`(date('now'))`)", 'string'],
		[{ type: 'datetime', required: true }, "text('x').notNull()", 'string'],
		[{ type: 'datetime', default: 'now' }, "text('x').default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)", 'string'],
		[{ type: 'datetime', timezone: false, default: 'now' }, "text('x').default(sql`(strftime('%Y-%m-%dT%H:%M:%f', 'now'))`)", 'string'],
		[{ type: 'json' }, "text('x', { mode: 'json' })", 'unknown'],
		[{ type: 'json', default: { a: 1 } }, 'text(\'x\', { mode: \'json\' }).default({"a":1})', 'unknown'],
		[{ type: 'string_array' }, "text('x', { mode: 'json' }).$type<string[]>()", '(string)[]'],
		[{ type: 'enum', choices: ['open', 'closed'], required: true }, "text('x', { enum: ['open', 'closed'] }).notNull()", "'open' | 'closed'"],
		[{ type: 'enum', choices: ['a', "o'k"], default: 'a' }, "text('x', { enum: ['a', 'o\\'k'] }).default('a')", "'a' | 'o\\'k'"],
		[{ type: 'string', default: 'hi' }, "text('x').default('hi')", 'string'],
		[{ type: 'integer', default: 0 }, "integer('x').default(0)", 'number'],
	])('%o → %s', (field, chain, tsType) => {
		const r = render(field);
		expect(r.drizzleChain).toBe(chain);
		expect(r.tsType).toBe(tsType);
		expect(sqlite.importFor(r.drizzleType)).toBe(r.drizzleType);
	});

	it('the id is TEXT, made by the application; a joined-table child’s is its base row’s', () => {
		const plain = deriveTableColumns({
			isChild: false,
			inherited: null,
			matched: [],
			belongsTo: [],
			fields: [],
			externalIdTracking: false,
			tenant: null,
			timestamps: null,
			softDelete: null,
		})[0]!;
		expect(renderSqliteColumn(plain).drizzleChain).toBe("text('id').primaryKey().$defaultFn(() => crypto.randomUUID())");
		expect(renderSqliteColumn({ ...plain, generatedId: false }).drizzleChain).toBe("text('id').primaryKey()");
	});

	it('timestampColumn is ISO TEXT and still refuses a missing zone (#845)', () => {
		expect(sqlite.timestampColumn('created_at', true)).toBe("text('created_at')");
		expect(() => (sqlite.timestampColumn as (c: string, tz?: unknown) => string)('created_at')).toThrow(/withTimezone/);
	});
});
