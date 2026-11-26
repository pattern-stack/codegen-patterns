/**
 * TGT-0b (ADR-047): `target:`'s schema is built from a pair table by `targetConfigSchemaFor`. Today's table has one
 * row, so the parse goes through a lone strict object; a second row turns it into a `z.union`, whose failure Zod 3
 * reports as one `invalid_union` issue. This builds the schema over a TWO-row table so the union path is held to the
 * same promises before the second pair exists: it accepts exactly the rows, refuses the cross product's other
 * members, names the supported pairs, and its JSON Schema offers exactly the rows to an editor.
 */

import Ajv from 'ajv';
import { describe, expect, it } from 'bun:test';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { objectSchemaKeys } from '../../config/project-config';
import { targetConfigSchemaFor, type TargetPairRow } from '../../schema/codegen-config.schema';

const TWO: TargetPairRow[] = [
	{ database: 'postgres', orm: 'drizzle', databaseDescription: 'pg', ormDescription: 'drizzle' },
	{ database: 'sqlite', orm: 'kysely', databaseDescription: 'sqlite', ormDescription: 'kysely' },
];
const SUPPORTED = 'supported: { database: postgres, orm: drizzle }, { database: sqlite, orm: kysely }';

const schema = targetConfigSchemaFor(TWO);
const issuesOf = (value: unknown) => {
	const r = schema.safeParse(value);
	return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || '(target)'}: ${i.message}`);
};

describe('target: over a two-row table (the union path)', () => {
	it.each(TWO.map((p) => [`${p.orm}/${p.database}`, { database: p.database, orm: p.orm }] as const))(
		'%s parses',
		(_n, pair) => {
			expect(schema.parse(pair)).toEqual(pair);
		},
	);

	it('a member of the cross product that is not a row is refused, naming the supported pairs', () => {
		expect(issuesOf({ database: 'sqlite', orm: 'drizzle' })).toEqual([
			`(target): { database: sqlite, orm: drizzle } is not a supported (database, orm) pair; ${SUPPORTED}`,
		]);
		expect(issuesOf({ database: 'postgres', orm: 'kysely' })).toEqual([
			`(target): { database: postgres, orm: kysely } is not a supported (database, orm) pair; ${SUPPORTED}`,
		]);
	});

	it('a missing key says both are required', () => {
		expect(issuesOf({ database: 'sqlite' })).toEqual([`(target): required: write both database and orm; ${SUPPORTED}`]);
		expect(issuesOf({})).toEqual([`(target): required: write both database and orm; ${SUPPORTED}`]);
	});

	it('an unknown key beside a supported pair is Zod\'s unrecognized_keys, and the loader finds the keys to list', () => {
		// The matching row's strict object reports it (a non-fatal issue wins over the union's), so the loader's
		// `unknown key (expected one of: …)` formatting applies — given it can see through the union for the keys.
		const r = schema.safeParse({ database: 'postgres', orm: 'drizzle', http: 'hono' });
		expect(r.success).toBe(false);
		expect(r.error!.issues.map((i) => [i.code, i.path, 'keys' in i ? i.keys : []])).toEqual([
			['unrecognized_keys', [], ['http']],
		]);
		expect(objectSchemaKeys(schema)).toEqual(['database', 'orm']);
	});

	it('an unknown key with no pair is named by the union message', () => {
		expect(issuesOf({ data: 'drizzle-pg' })).toEqual(['(target): unknown key data (expected one of: database, orm)']);
	});

	it('a bare string says what to write', () => {
		expect(issuesOf('drizzle-postgres')).toEqual([`(target): write { database, orm }; ${SUPPORTED}`]);
	});

	it('its JSON Schema offers exactly the rows, and refuses the rest', () => {
		const json = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as {
			anyOf: Array<{ properties: { database: { const: string }; orm: { const: string } } }>;
		};
		expect(json.anyOf.map((a) => ({ database: a.properties.database.const, orm: a.properties.orm.const }))).toEqual(
			TWO.map(({ database, orm }) => ({ database, orm })),
		);
		const validate = new Ajv({ strict: true }).compile(json);
		for (const p of TWO) expect(validate({ database: p.database, orm: p.orm })).toBe(true);
		expect(validate({ database: 'sqlite', orm: 'drizzle' })).toBe(false);
		expect(validate({ database: 'postgres', orm: 'kysely' })).toBe(false);
	});

	it('an empty table is a programming error, not an empty union', () => {
		expect(() => targetConfigSchemaFor([])).toThrow('the pair table is empty');
	});
});
