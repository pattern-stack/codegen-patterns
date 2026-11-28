/**
 * `generate.commands: false` (ID-1): the derivation's one switch for an entity's generated commands. Off, the surface
 * has no commands and records where that came from; on (the default), nothing about it changes.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commandsDisabledBy } from '../../derived/api/entity';
import { deriveProjectApiSurface, loadProjectApiContext } from '../../derived/api/project';

function surfaceOf(yaml: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-off-'));
	fs.writeFileSync(path.join(dir, 'thing.yaml'), yaml);
	const ctx = loadProjectApiContext('/app/src', null, {
		entitiesDir: dir,
		junctionsDir: '/nonexistent/junctions',
		relationshipsDir: '/nonexistent/relationships',
	});
	return deriveProjectApiSurface(ctx).entities.thing!;
}

const YAML = 'entity:\n  name: thing\n  plural: things\nfields:\n  name:\n    type: string\n    required: true\n';

describe('generate.commands', () => {
	it('is the one switch: off names its YAML path, on (or absent) is null', () => {
		expect(commandsDisabledBy({ generate: { commands: false } })).toEqual(['generate', 'commands']);
		expect(commandsDisabledBy({ generate: { commands: true } })).toBeNull();
		expect(commandsDisabledBy({ generate: undefined })).toBeNull();
	});

	it('off: no commands, and the surface records why; the use cases stay', () => {
		const off = surfaceOf(`${YAML}generate:\n  commands: false\n`);
		expect(off.commands).toEqual([]);
		expect(off.commandsDisabledBy?.path).toEqual(['generate', 'commands']);
		expect(off.useCases.length).toBeGreaterThan(0);
		const on = surfaceOf(YAML);
		expect(on.commands.length).toBeGreaterThan(0);
		expect(on).not.toHaveProperty('commandsDisabledBy');
	});
});
