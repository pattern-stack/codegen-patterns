/**
 * ZOD-1a: a PATCH leaves an omitted field as it is.
 *
 * An update DTO built as `Create.partial()` carries the create schema's `.default()` along. Zod 3 ignores a default
 * under `.optional()`; Zod 4 applies it, so `Update.parse({})` would come back `{ active: true }` and a PATCH that
 * leaves `active` out would reset it. Every update DTO therefore restates its create schema's defaulted fields
 * without the default (`updateDefaultOverrides`), and a family child's update extends its base's update.
 *
 * The generated DTOs themselves are loaded and parsed here, with the Zod the generated apps run (Zod 4 since ZOD-1b;
 * ZOD-1a ran them under Zod 3 as well).
 */

import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import relationshipPrompt from '../../../templates/relationship/new/prompt.js';
import { renderAllBackendFiles } from '../derived/_render';
import { RENDER_MATRIX } from '../derived/_render-matrix';

const REPO = path.resolve(import.meta.dir, '../../..');
// Inside the repo's node_modules, so the generated files' bare `zod` import resolves.
const SCRATCH = fs.mkdtempSync(path.join(REPO, 'node_modules', '.cache-update-dto-'));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const ZODS = [{ name: 'Zod 4', specifier: 'zod' }] as const;

/** The case's DTO files, written once per Zod with `from 'zod'` pointed at it; returns the module root per Zod. */
function writeDtos(): Record<string, string> {
	const set = RENDER_MATRIX.find((c) => c.id === 'matrix-update-defaults');
	if (set === undefined) throw new Error('render matrix has no matrix-update-defaults case');
	const files = renderAllBackendFiles(set, set.entities.map((d) => d.entity.name));
	const roots: Record<string, string> = {};
	for (const zod of ZODS) {
		const root = path.join(SCRATCH, zod.specifier);
		for (const [rel, text] of files) {
			if (!rel.includes('/dto/')) continue;
			const target = path.join(root, rel);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, text.replaceAll("from 'zod';", `from '${zod.specifier}';`));
		}
		roots[zod.specifier] = path.join(root, 'src/modules');
	}
	return roots;
}

const roots = writeDtos();
type Schema = { parse(v: unknown): unknown; safeParse(v: unknown): { success: boolean } };
const load = async (specifier: string, file: string, name: string): Promise<Schema> =>
	(await import(path.join(roots[specifier]!, file)))[name] as Schema;

for (const zod of ZODS) {
	describe(`generated update DTOs leave omitted fields alone (${zod.name})`, () => {
		it('a plain entity: no default on update, the create still defaults', async () => {
			const update = await load(zod.specifier, 'shelves/dto/update-shelf.dto.ts', 'UpdateShelfSchema');
			const create = await load(zod.specifier, 'shelves/dto/create-shelf.dto.ts', 'CreateShelfSchema');
			expect(update.parse({})).toEqual({});
			expect(update.parse({ label: 'B2' })).toEqual({ label: 'B2' });
			expect(update.parse({ active: false })).toEqual({ active: false });
			// Exactly what `Create.partial()` accepted: a defaulted boolean was never nullable on create or update.
			expect(update.safeParse({ active: null }).success).toBe(false);
			// The create applies the YAML's own default (`active: true`, `archived: false`).
			expect(create.parse({ label: 'B2' })).toEqual({ label: 'B2', active: true, archived: false });
		});

		it("a family base: the update omits the kind and the base's defaults", async () => {
			const update = await load(zod.specifier, 'totes/dto/update-tote.dto.ts', 'UpdateToteSchema');
			expect(update.parse({})).toEqual({});
			expect(update.parse({ kind: 'bin' })).toEqual({});
		});

		it("a family child: its update extends the base's, and neither applies a default", async () => {
			const update = await load(zod.specifier, 'bins/dto/update-bin.dto.ts', 'UpdateBinSchema');
			expect(update.parse({})).toEqual({});
			expect(update.parse({ label: 'x' })).toEqual({ label: 'x' });
			expect(update.parse({ fragile: true, sealed: false })).toEqual({ fragile: true, sealed: false });
		});
	});
}

describe('relationship update DTOs leave omitted fields alone', () => {
	const tmp: string[] = [];
	afterAll(() => {
		for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
	});

	async function locals(): Promise<Record<string, any>> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-update-defaults-'));
		tmp.push(dir);
		fs.mkdirSync(path.join(dir, 'entities'));
		fs.writeFileSync(path.join(dir, 'entities', 'player.yaml'), 'entity:\n  name: player\n  plural: players\n');
		fs.writeFileSync(path.join(dir, 'entities', 'team.yaml'), 'entity:\n  name: team\n  plural: teams\n');
		fs.writeFileSync(path.join(dir, 'codegen.config.yaml'), '');
		const file = path.join(dir, 'def.yaml');
		fs.writeFileSync(
			file,
			'relationship:\n  name: player_team\n  from: player\n  to: team\nfields:\n  captain:\n    type: boolean\n    default: true\n  notes:\n    type: string\n',
		);
		const cwd = process.cwd();
		process.chdir(dir);
		try {
			return (await relationshipPrompt.prompt({ args: { yaml: file } })) as Record<string, any>;
		} finally {
			process.chdir(cwd);
		}
	}

	it('restates only the defaulted field, without the default', async () => {
		const l = await locals();
		expect(l.updateDefaultOverrides.map((f: { name: string }) => f.name)).toEqual(['captain']);
		expect(l.updateDefaultOverrides[0].zodChainUpdate).toBe('z.boolean().optional()');
		// The create applies the YAML's own default value.
		expect(l.createDtoFields.find((f: { name: string }) => f.name === 'captain').zodChainCreate).toBe(
			'z.boolean().default(true)',
		);
	});

	{
		it('the update the template prints parses {} to {}', async () => {
			const l = await locals();
			// As update.ejs.t prints it: `Create.partial().extend({ <overrides> })`.
			const chain = (src: string) => new Function('z', `return ${src};`)(z);
			const create = z.object(
				Object.fromEntries(l.createDtoFields.map((f: any) => [f.camelName, chain(f.zodChainCreate)])),
			);
			const update = create
				.partial()
				.extend(
					Object.fromEntries(l.updateDefaultOverrides.map((f: any) => [f.camelName, chain(f.zodChainUpdate)])),
				);
			expect(update.parse({})).toEqual({});
		});
	}
});
