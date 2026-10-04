/**
 * `relationship new` extra fields follow the entity pipeline's nullability
 * rule (`src/schema/field-nullability.ts`, #736 / #613). Relationship `fields:`
 * are not parsed by `FieldDefinitionSchema`, so the prompt repeats its refusal.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import relationshipPrompt from '../../../templates/relationship/new/prompt.js';
import { NOT_NULL_WITHOUT_DEFAULT_MESSAGE } from '../../schema/field-nullability';

const tmpDirs: string[] = [];
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function localsFor(fieldsYaml: string): Promise<Record<string, any>> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-nullability-'));
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

const byName = (list: { name: string }[], name: string): any => list.find((f) => f.name === name);
const field = (l: Record<string, any>, name: string) => ({
	...byName(l.processedFields, name),
	zodChainCreate: byName(l.createDtoFields, name).zodChainCreate,
	zodChainOutput: byName(l.outputDtoFields, name).zodChainOutput,
});

describe('relationship extra-field nullability (#736)', () => {
	it('nullable: false + default → NOT NULL carrying the default; optional create, non-null read', async () => {
		const l = await localsFor('  minutes:\n    type: integer\n    nullable: false\n    default: 0\n');
		const minutes = field(l, 'minutes');
		expect(minutes.drizzleChain).toBe("integer('minutes').notNull().default(0)");
		expect(minutes.zodChainCreate).toBe('z.number().int().optional()');
		expect(minutes.zodChainOutput).toBe('z.number().int()');
	});

	it('an undeclared field is a nullable column and reads as nullable', async () => {
		const l = await localsFor('  jersey:\n    type: string\n');
		const jersey = field(l, 'jersey');
		expect(jersey.drizzleChain).toBe("text('jersey')");
		expect(jersey.zodChainOutput).toBe('z.string().nullable()');
	});

	it('required: true → NOT NULL', async () => {
		const l = await localsFor('  since:\n    type: date\n    required: true\n');
		expect(field(l, 'since').drizzleChain).toBe("date('since').notNull()");
	});

	it('refuses nullable: false without a default', async () => {
		await expect(localsFor('  minutes:\n    type: integer\n    nullable: false\n')).rejects.toThrow(
			NOT_NULL_WITHOUT_DEFAULT_MESSAGE,
		);
	});
});
