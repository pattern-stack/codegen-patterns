/**
 * `max_length` / `min_length` on a `string` field (#772): one rule
 * (`stringLengthBounds` in entity-locals.js) read by the entity pipeline and
 * the relationship pipeline. `max_length` → `varchar(n)` column; both bounds →
 * `.min(n)` / `.max(n)` on the create DTO (the update DTO is its `.partial()`).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import relationshipPrompt from '../../../templates/relationship/new/prompt.js';
import { FieldDefinitionSchema } from '../../schema/entity-definition.schema';
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
		tier: { type: 'string', choices: ['a', 'b'], max_length: 1 },
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
});
