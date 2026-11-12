/**
 * `max_length` / `min_length` on a `string` field (#772): one rule
 * (`stringLengthBounds` in entity-locals.js) read by the entity, junction and
 * relationship pipelines. `max_length` → `varchar(n)` column; both bounds →
 * `.min(n)` / `.max(n)` on the create DTO (the update DTO is its `.partial()`).
 * A junction has no DTOs, so its `max_length` is the column's alone.
 *
 * Whether the keys are accepted is `fieldLengthIssues` (src/schema/field-length.ts):
 * string only, never next to `choices:`, min ≤ max — read by the entity /
 * junction schema and by the relationship prompt.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import junctionPrompt from '../../../templates/junction/new/prompt.js';
import relationshipPrompt from '../../../templates/relationship/new/prompt.js';
import { EntityDefinitionSchema, FieldDefinitionSchema } from '../../schema/entity-definition.schema';
import { withEntities } from './_entity-lookup';

const ENTITY_TEMPLATE = readFileSync(
	path.resolve(import.meta.dir, '../../../templates/entity/new/backend/entity.ejs.t'),
	'utf8',
);
const body = (src: string) => src.split('\n---\n').slice(1).join('\n---\n');

const definition = {
	entity: { name: 'season', plural: 'seasons', pattern: 'Base' },
	fields: {
		label: { type: 'string', required: true, max_length: 3 },
		code: { type: 'string', min_length: 2, max_length: 8 },
		slug: { type: 'string', min_length: 1 },
		notes: { type: 'string' },
		tier: { type: 'string', choices: ['a', 'b'] },
	},
	relationships: {},
	behaviors: [],
};

const byName = (list: { name: string }[], name: string): any => list.find((f) => f.name === name);

describe('entity pipeline — string length bounds (#772)', () => {
	const locals = buildBackendLocals(definition, withEntities()) as any;

	it('max_length → varchar(n) column; no max_length → text', () => {
		expect(byName(locals.processedFields, 'label').drizzleChain).toBe(
			"varchar('label', { length: 3 }).notNull()",
		);
		expect(byName(locals.processedFields, 'code').drizzleChain).toBe("varchar('code', { length: 8 })");
		expect(byName(locals.processedFields, 'slug').drizzleChain).toBe("text('slug')");
		expect(byName(locals.processedFields, 'notes').drizzleChain).toBe("text('notes')");
	});

	it('the entity file imports varchar', () => {
		const out = ejs.render(body(ENTITY_TEMPLATE), locals);
		expect(out).toMatch(/^\s+varchar,$/m);
	});

	it('both bounds check the create DTO, before nullability', () => {
		expect(byName(locals.createDtoFields, 'label').zodChainCreate).toBe('z.string().max(3)');
		expect(byName(locals.createDtoFields, 'code').zodChainCreate).toBe(
			'z.string().min(2).max(8).nullable().optional()',
		);
		expect(byName(locals.createDtoFields, 'slug').zodChainCreate).toBe('z.string().min(1).nullable().optional()');
	});

	it('choices: an enum column, no length check', () => {
		const tier = byName(locals.processedFields, 'tier');
		expect(tier.drizzleType).toBe('enum');
		expect(byName(locals.createDtoFields, 'tier').zodChainCreate).not.toContain('.max(');
	});
});

describe('schema — string length bounds', () => {
	it('refuses min_length > max_length', () => {
		const r = FieldDefinitionSchema.safeParse({ type: 'string', min_length: 5, max_length: 3 });
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error?.issues)).toContain("'min_length' cannot exceed 'max_length'");
	});
	it('accepts min_length == max_length', () => {
		expect(FieldDefinitionSchema.safeParse({ type: 'string', min_length: 3, max_length: 3 }).success).toBe(true);
	});
	it('refuses a length key on a non-string field', () => {
		const r = FieldDefinitionSchema.safeParse({ type: 'integer', max_length: 3 });
		expect(r.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toContain(
			"max_length: 'max_length' can only be used with type 'string'",
		);
	});
});

// An enum's values bound it, so a length key next to `choices:` was parsed and
// ignored — now each pipeline refuses it, naming the field.
describe('schema — a length key on an enum field is refused (#772)', () => {
	const entity = (field: Record<string, unknown>) =>
		EntityDefinitionSchema.safeParse({ entity: { name: 'season', plural: 'seasons' }, fields: { tier: field } });
	const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
		r.success ? [] : r.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

	for (const key of ['max_length', 'min_length'] as const) {
		it(`entity: choices + ${key}`, () => {
			expect(issues(entity({ type: 'string', choices: ['a', 'b'], [key]: 1 }))).toContainEqual(
				`fields.tier.${key}: '${key}' does not apply to an enum field ('choices:'): its values bound its length — remove '${key}'`,
			);
		});
	}
	it('entity: choices_from + max_length', () => {
		expect(issues(entity({ type: 'string', choices_from: 'tiers.yaml', max_length: 1 }))).toContainEqual(
			expect.stringContaining("fields.tier.max_length: 'max_length' does not apply to an enum field ('choices_from:')"),
		);
	});
	it('entity: a string without choices keeps both keys', () => {
		expect(entity({ type: 'string', min_length: 1, max_length: 3 }).success).toBe(true);
	});
});

describe('relationship pipeline — the same rule', () => {
	const tmpDirs: string[] = [];
	afterEach(() => {
		for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});
	async function localsFor(fieldsYaml: string): Promise<Record<string, any>> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-length-'));
		tmpDirs.push(dir);
		fs.mkdirSync(path.join(dir, 'entities'));
		fs.writeFileSync(path.join(dir, 'entities', 'player.yaml'), 'entity:\n  name: player\n  plural: players\n');
		fs.writeFileSync(path.join(dir, 'entities', 'team.yaml'), 'entity:\n  name: team\n  plural: teams\n');
		fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), '');
		const file = path.join(dir, 'def.yaml');
		fs.writeFileSync(file, `relationship:\n  name: player_team\n  from: player\n  to: team\nfields:\n${fieldsYaml}`);
		const cwd = process.cwd();
		process.chdir(dir);
		try {
			return (await relationshipPrompt.prompt({ args: { yaml: file } })) as Record<string, any>;
		} finally {
			process.chdir(cwd);
		}
	}

	it('max_length → varchar(n) + .max(n); the import is emitted', async () => {
		const l = await localsFor('  jersey:\n    type: string\n    min_length: 1\n    max_length: 3\n');
		expect(byName(l.processedFields, 'jersey').drizzleChain).toBe("varchar('jersey', { length: 3 })");
		expect(byName(l.createDtoFields, 'jersey').zodChainCreate).toBe('z.string().min(1).max(3).nullable().optional()');
		expect(l.drizzleImports).toContain('varchar');
	});

	it('refuses a length key on a non-string field', async () => {
		await expect(localsFor('  minutes:\n    type: integer\n    max_length: 3\n')).rejects.toThrow(
			"'max_length' can only be used with type 'string'",
		);
	});

	it('refuses a length key on an enum field, naming the field', async () => {
		for (const key of ['max_length', 'min_length']) {
			await expect(
				localsFor(`  tier:\n    type: string\n    choices: [a, b]\n    ${key}: 1\n`),
			).rejects.toThrow(`relationship field 'tier': '${key}' does not apply to an enum field ('choices:')`);
		}
	});

	it('refuses min_length > max_length', async () => {
		await expect(localsFor('  code:\n    type: string\n    min_length: 5\n    max_length: 3\n')).rejects.toThrow(
			"relationship field 'code': 'min_length' cannot exceed 'max_length'",
		);
	});
});

describe('junction pipeline — the same rule (#772)', () => {
	const tmpDirs: string[] = [];
	afterEach(() => {
		for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	});
	const JUNCTION_ENTITY_TEMPLATE = readFileSync(
		path.resolve(import.meta.dir, '../../../templates/junction/new/entity.ejs.t'),
		'utf8',
	);
	async function junctionLocals(fieldsYaml: string): Promise<Record<string, any>> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-length-'));
		tmpDirs.push(dir);
		fs.mkdirSync(path.join(dir, 'entities'));
		fs.writeFileSync(path.join(dir, 'entities', 'player.yaml'), 'entity:\n  name: player\n  plural: players\n');
		fs.writeFileSync(path.join(dir, 'entities', 'team.yaml'), 'entity:\n  name: team\n  plural: teams\n');
		fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), '');
		const file = path.join(dir, 'junction.yaml');
		fs.writeFileSync(file, `pattern: Junction\nbetween: [player, team]\nfields:\n${fieldsYaml}`);
		const cwd = process.cwd();
		process.chdir(dir);
		try {
			return (await junctionPrompt.prompt({ args: { yaml: file } })) as Record<string, any>;
		} finally {
			process.chdir(cwd);
		}
	}

	it('max_length → a varchar(n) column, imported', async () => {
		const out = ejs.render(body(JUNCTION_ENTITY_TEMPLATE), await junctionLocals('  jersey: { type: string, max_length: 3 }\n'));
		expect(out).toContain("jersey: varchar('jersey', { length: 3 }),");
		expect(out).toMatch(/^\s+varchar,$/m);
	});
});
