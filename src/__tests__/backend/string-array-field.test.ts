/**
 * #281 — `type: string_array` is a Postgres text[] end to end: the column
 * (`text('x').array()`), the DTOs (`z.array(z.string())`), the entity type
 * (`string[]`) and the Integrated sink's copy-through member. With `choices:`
 * it is an ARRAY of the enum, never a single enum column (F4).
 *
 * The baseline fixture `test/fixtures/entities/person.yaml` carries both
 * shapes, so the baseline typecheck compiles them against Drizzle 1.0; this
 * file pins the locals that produce them — and the same rule in the
 * relationship and junction pipelines' extra fields.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ejs from 'ejs';
import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import junctionPrompt from '../../../templates/junction/new/prompt.js';
import relationshipPrompt from '../../../templates/relationship/new/prompt.js';
import { buildSinkInput } from '../../cli/shared/adapter-emission-generator';
import { withEntities } from './_entity-lookup';

const BASE = withEntities({ runtimeMode: 'vendored' });

const definition = {
	entity: { name: 'player', plural: 'players', table: 'players' },
	fields: {
		nicknames: { type: 'string_array', nullable: true },
		positions: { type: 'string_array', choices: ['pg', 'sg', 'sf'], required: true, default: ['pg'] },
	},
	relationships: {},
	behaviors: [],
};

type Field = {
	name: string;
	drizzleChain: string;
	tsType: string;
	zodType: string;
	zodChainCreate?: string;
	zodChainOutput?: string;
};

const byName = (fields: Field[], name: string): Field => {
	const f = fields.find((x) => x.name === name);
	if (!f) throw new Error(`no field ${name}`);
	return f;
};

describe('string_array (#281)', () => {
	const locals = buildBackendLocals(definition, BASE) as Record<string, any>;

	it('is a Postgres text[] column, not text', () => {
		const f = byName(locals.processedFields, 'nicknames');
		expect(f.drizzleChain).toBe("text('nicknames').array()");
		expect(f.tsType).toBe('string[]');
		expect(f.zodType).toBe('z.array(z.string())');
	});

	it('carries a real array schema through both DTOs, never z.unknown()', () => {
		expect(byName(locals.createDtoFields, 'nicknames').zodChainCreate).toBe(
			'z.array(z.string()).nullable().optional()',
		);
		expect(byName(locals.outputDtoFields, 'nicknames').zodChainOutput).toBe('z.array(z.string()).nullable()');
	});

	it('with choices: an enum ARRAY column, its default an array of literals (F4)', () => {
		const f = byName(locals.processedFields, 'positions');
		expect(f.drizzleChain).toBe("playerPositionsEnum('positions').array().notNull().default(['pg'])");
		expect(f.tsType).toBe("('pg' | 'sg' | 'sf')[]");
		expect(byName(locals.createDtoFields, 'positions').zodChainCreate).toBe("z.array(z.enum(['pg', 'sg', 'sf']))");
		expect(byName(locals.outputDtoFields, 'positions').zodChainOutput).toBe("z.array(z.enum(['pg', 'sg', 'sf']))");
	});

	it('the Integrated sink copies it through as string[], not unknown', () => {
		const sink = buildSinkInput(
			{
				entity: { name: 'player', plural: 'players', pattern: 'Integrated', surface: 'stats' },
				fields: { nicknames: { type: 'string_array', nullable: true } },
				relationships: {},
			} as Parameters<typeof buildSinkInput>[0],
			'stats',
			'provider',
			'../players/player.repository',
		);
		expect(sink.copyThroughFields).toContainEqual({ camelName: 'nicknames', tsType: 'string[] | null' });
	});
});

// ---------------------------------------------------------------------------
// The same rule in the relationship and junction pipelines' extra fields.
// ---------------------------------------------------------------------------

const TEMPLATES = path.resolve(import.meta.dir, '../../../templates');

function render(template: string, locals: Record<string, unknown>): string {
	const source = fs.readFileSync(path.join(TEMPLATES, template), 'utf8');
	return ejs.render(source.replace(/^---\n[\s\S]*?\n---\n/, ''), locals, { rmWhitespace: false });
}

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ENDPOINTS = {
	player: 'entity:\n  name: player\n  plural: players\n',
	team: 'entity:\n  name: team\n  plural: teams\n',
};

const EXTRA_FIELDS =
	'fields:\n' +
	'  tags:\n    type: string_array\n    nullable: true\n' +
	'  slots:\n    type: string_array\n    choices: [pg, sg]\n';

async function promptIn(
	prompt: { prompt: (a: { args: { yaml: string } }) => Promise<unknown> },
	yamlBody: string,
): Promise<Record<string, any>> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'string-array-'));
	tmpDirs.push(dir);
	fs.mkdirSync(path.join(dir, 'entities'));
	for (const [name, body] of Object.entries(ENDPOINTS)) {
		fs.writeFileSync(path.join(dir, 'entities', `${name}.yaml`), body);
	}
	fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), '');
	const file = path.join(dir, 'def.yaml');
	fs.writeFileSync(file, yamlBody);
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		return (await prompt.prompt({ args: { yaml: file } })) as Record<string, any>;
	} finally {
		process.chdir(cwd);
	}
}

describe('string_array in relationship and junction extra fields (#281)', () => {
	it('relationship: text[] / enum[] columns, array DTO schemas', async () => {
		const l = await promptIn(
			relationshipPrompt,
			`relationship:\n  name: player_team\n  from: player\n  to: team\n${EXTRA_FIELDS}`,
		);
		const entity = render('relationship/new/entity.ejs.t', l);
		expect(entity).toContain("tags: text('tags').array(),");
		expect(entity).toMatch(/slots: \w+Enum\('slots'\)\.array\(\),/);
		const tags = l.processedFields.find((f: { name: string }) => f.name === 'tags');
		expect(tags.tsType).toBe('string[]');
		expect(tags.zodType).toBe('z.array(z.string())');
		const dto = render('relationship/new/dto/create.ejs.t', l);
		expect(dto).toContain('tags: z.array(z.string()).nullable().optional(),');
		// `slots` declares no nullability, so its column is nullable — and the
		// DTO says so (#613: one rule for the column and the read/write types).
		expect(dto).toContain("slots: z.array(z.enum(['pg', 'sg'])).nullable().optional(),");
		expect(dto).not.toContain('z.unknown()');
	});

	it('junction: text[] / enum[] columns', async () => {
		const l = await promptIn(junctionPrompt, `pattern: Junction\nbetween: [player, team]\n${EXTRA_FIELDS}`);
		const entity = render('junction/new/entity.ejs.t', l);
		expect(entity).toContain("tags: text('tags').array(),");
		expect(entity).toMatch(/slots: \w+Enum\('slots'\)\.array\(\),/);
	});
});
