/**
 * TGT-0b (ADR-047): `src/schema/codegen-config.schema.json` — the editor's view of `codegen.config.yaml` — is derived
 * from the config's Zod schema, so it offers exactly the `(database, orm)` pairs in `TARGET_PAIRS` and refuses every
 * other pair, as the Zod schema does. Every case runs through BOTH schemas: the two must agree.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import { CodegenConfigObjectSchema } from '../../schema/codegen-config.schema';
import { renderCodegenConfigJsonSchema } from '../../schema/codegen-config.json-schema';
import { TARGET_PAIRS } from '../../targets/pairs';
import { CONFIG_JSON_SCHEMA_PATH, jsonSchemaErrors } from './_config-json-schema';

const zodAccepts = (config: unknown) => CodegenConfigObjectSchema.safeParse(config).success;

describe('the committed JSON Schema is the generated one', () => {
	it('regenerate with `just gen-config-schema` when this fails', () => {
		expect(fs.readFileSync(CONFIG_JSON_SCHEMA_PATH, 'utf-8')).toBe(renderCodegenConfigJsonSchema());
	});
});

describe('target: in the JSON Schema is TARGET_PAIRS', () => {
	const target = JSON.parse(fs.readFileSync(CONFIG_JSON_SCHEMA_PATH, 'utf-8')).properties.target;
	/** One alternative per pair: a lone object, or `anyOf` once a second pair exists. */
	const alternatives: Array<{ properties: Record<string, { const: string; description: string }> }> =
		target.anyOf ?? [target];

	it('offers exactly the table pairs, each key described', () => {
		const offered = alternatives.map((a) => ({ database: a.properties.database.const, orm: a.properties.orm.const }));
		expect(offered).toEqual(TARGET_PAIRS.map(({ database, orm }) => ({ database, orm })));
		alternatives.forEach((a, i) => {
			expect(a.properties.database.description).toBe(TARGET_PAIRS[i]!.databaseDescription);
			expect(a.properties.orm.description).toBe(TARGET_PAIRS[i]!.ormDescription);
		});
	});

	it.each(TARGET_PAIRS.map(({ database, orm }) => [`${orm}/${database}`, { database, orm }] as const))(
		'%s is accepted by both schemas',
		(_name, pair) => {
			expect(zodAccepts({ target: pair })).toBe(true);
			expect(jsonSchemaErrors({ target: pair })).toEqual([]);
		},
	);

	it('an absent target is accepted by both (the first row is the default)', () => {
		expect(zodAccepts({})).toBe(true);
		expect(jsonSchemaErrors({})).toEqual([]);
	});

	const databases = [...new Set<string>([...TARGET_PAIRS.map((p) => p.database), 'sqlite'])];
	const orms = [...new Set<string>([...TARGET_PAIRS.map((p) => p.orm), 'kysely'])];
	const offTable = databases
		.flatMap((database) => orms.map((orm) => ({ database, orm })))
		.filter((p) => !TARGET_PAIRS.some((row) => row.database === p.database && row.orm === p.orm));
	const refused: Array<[string, unknown]> = [
		...offTable.map((p) => [`${p.orm}/${p.database}`, p] as [string, unknown]),
		['TGT-0 key, { data: drizzle-pg }', { data: 'drizzle-pg' }],
		['one key, { database: postgres }', { database: 'postgres' }],
		['an empty object (written, both keys are required)', {}],
		['an http value no app has', { database: TARGET_PAIRS[0].database, orm: TARGET_PAIRS[0].orm, http: 'express' }],
		['a bare string', 'drizzle-postgres'],
	];

	it.each(refused)('%s is refused by both schemas', (_name, target) => {
		const config = { target };
		expect(zodAccepts(config)).toBe(false);
		expect(jsonSchemaErrors(config)).not.toEqual([]);
	});

	it('the refusal set includes off-table pairs (the cross product is not empty)', () => {
		expect(offTable.length).toBeGreaterThan(0);
	});
});
