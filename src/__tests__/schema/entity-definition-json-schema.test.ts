/**
 * ZOD-0 (#696): `src/schema/entity-definition.schema.json` — the editor's view of an entity YAML — is derived from
 * `EntityDefinitionSchema`, not restated by hand. It must not drift from its source, and it must not underline a file
 * the generator accepts. Every case runs through BOTH schemas.
 */

import Ajv from 'ajv';
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Glob } from 'bun';
import { parse as parseYaml } from 'yaml';
import { EntityDefinitionSchema } from '../../schema/entity-definition.schema';
import { renderEntityDefinitionJsonSchema } from '../../schema/entity-definition.json-schema';

const REPO = path.resolve(import.meta.dir, '../../..');
const JSON_SCHEMA_PATH = path.join(REPO, 'src/schema/entity-definition.schema.json');

const validate = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(JSON_SCHEMA_PATH, 'utf-8')));
const jsonSchemaAccepts = (data: unknown) => validate(data) === true;

describe('the committed entity JSON Schema is the generated one', () => {
	it('regenerate with `just gen-entity-schema` when this fails', () => {
		expect(fs.readFileSync(JSON_SCHEMA_PATH, 'utf-8')).toBe(renderEntityDefinitionJsonSchema());
	});
});

describe('the JSON Schema accepts what the generator accepts', () => {
	// Every entity YAML in the repo (fixtures, examples, the demo and smoke sets), not only one harness's.
	const files = [...new Glob('**/entities/**/*.yaml').scanSync({ cwd: REPO })]
		.filter((file) => !file.includes('node_modules/'))
		.sort();
	const accepted = files
		.map((file) => ({ file, data: parseYaml(fs.readFileSync(path.join(REPO, file), 'utf-8')) as unknown }))
		.filter(({ data }) => EntityDefinitionSchema.safeParse(data).success);

	it('covers the repo\'s entity YAMLs', () => {
		expect(accepted.length).toBeGreaterThan(100);
	});

	it.each(accepted.map(({ file, data }) => [file, data] as const))('%s', (_file, data) => {
		const ok = jsonSchemaAccepts(data);
		expect(validate.errors ?? []).toEqual([]);
		expect(ok).toBe(true);
	});
});

describe('the JSON Schema refuses what an editor should underline', () => {
	const minimal = { entity: { name: 'deal', plural: 'deals' }, fields: { title: { type: 'string' } } };

	it.each([
		['an unknown top-level key', { ...minimal, colour: 'blue' }],
		['an unknown field type', { ...minimal, fields: { title: { type: 'strng' } } }],
		['an unknown field key', { ...minimal, fields: { title: { type: 'string', lenght: 3 } } }],
		['a missing entity block', { fields: minimal.fields }],
	])('%s', (_name, data) => {
		expect(EntityDefinitionSchema.safeParse(data).success).toBe(false);
		expect(jsonSchemaAccepts(data)).toBe(false);
	});

	it('a minimal entity is accepted by both', () => {
		expect(EntityDefinitionSchema.safeParse(minimal).success).toBe(true);
		expect(jsonSchemaAccepts(minimal)).toBe(true);
	});
});
