/**
 * PATH-1 (#645) — the clean-lite-ps module tree `<modules_dir>[/<context>]/<plural>`
 * is spelled in three places:
 *
 *   - `templates/_shared/entity-naming.mjs` › `entityModuleNaming` (the hygen
 *     emission itself);
 *   - `src/cli/shared/barrel-generator.ts` › `entityFilePaths` (the barrels);
 *   - `src/cli/shared/assembly-emission-generator.ts` › `resolveEntityModuleImports`
 *     (the integration assemblies and sinks).
 *
 * `src/` cannot import `templates/` outside tests, so until the three collapse
 * into one shipped module (#649) this test pins the two `src/` spellings against
 * the emission's for a flat, a `context:`-nested and an irregular-plural entity,
 * under a non-default `modules_dir`.
 */

import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import { entityModuleNaming } from '../../../templates/_shared/entity-naming.mjs';
import { entityFilePaths } from '../../cli/shared/barrel-generator';
import { resolveEntityModuleImports } from '../../cli/shared/assembly-emission-generator';

const MODULES_DIR = 'apps/backend/src/domain';
const ROOT = '/p';

const ENTITIES = [
	{ name: 'account', plural: 'accounts' },
	{ name: 'transcript', plural: 'transcripts', context: 'integration' },
	// `pluralize('person')` is `people`: the declared plural must win everywhere.
	{ name: 'person', plural: 'persons' },
];

describe('the module-tree spellings agree with entityModuleNaming', () => {
	for (const entity of ENTITIES) {
		const naming = entityModuleNaming(entity, MODULES_DIR);

		it(`barrel: ${entity.name}${entity.context ? ` (context: ${entity.context})` : ''}`, () => {
			const files = entityFilePaths(
				{ name: entity.name, plural: entity.plural, context: entity.context },
				'clean-lite-ps',
				{ backend_src: 'apps/backend/src', modules_dir: MODULES_DIR },
			);
			expect(files.schemaFile).toBe(`${naming.entityFile}.ts`);
			expect(files.moduleFile).toBe(`${naming.moduleDir}/${naming.plural}.module.ts`);
		});

		it(`assembly: ${entity.name}${entity.context ? ` (context: ${entity.context})` : ''}`, () => {
			const loc = resolveEntityModuleImports({
				entityName: entity.name,
				entityPlural: entity.plural,
				context: entity.context ?? null,
				surface: 'calendar',
				provider: 'google',
				backendSrcAbs: path.join(ROOT, 'apps/backend/src'),
				modulesAbs: path.join(ROOT, MODULES_DIR),
				aliases: {},
			});
			expect(loc.repoFileAbs).toBe(path.join(ROOT, naming.moduleDir, `${entity.name}.repository.ts`));
			expect(loc.moduleFileAbs).toBe(path.join(ROOT, naming.moduleDir, `${naming.plural}.module.ts`));
		});
	}
});
