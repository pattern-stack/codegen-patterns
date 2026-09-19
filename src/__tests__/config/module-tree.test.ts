/**
 * GEN-0 (#649) — the clean-lite-ps module tree `<modules_dir>[/<context>]/<plural>`
 * is one shipped function (`src/config/module-tree.ts`). The hygen emission
 * re-exports it; the barrels and the integration assemblies call it. This test
 * states the rule and that the emission's export IS that function.
 */

import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import { entityModuleNaming as emissionNaming } from '../../../templates/_shared/entity-naming.mjs';
import { entityModuleNaming } from '../../config/module-tree';
import { entityFilePaths } from '../../cli/shared/barrel-generator';
import { resolveEntityModuleImports } from '../../cli/shared/assembly-emission-generator';

const MODULES_DIR = 'apps/backend/src/domain';

describe('entityModuleNaming (src/config/module-tree.ts)', () => {
	it('is the function the hygen emission uses', () => {
		expect(emissionNaming).toBe(entityModuleNaming);
	});

	it('flat: <modules_dir>/<plural>', () => {
		expect(entityModuleNaming({ name: 'account', plural: 'accounts' }, MODULES_DIR)).toEqual({
			plural: 'accounts',
			moduleDir: `${MODULES_DIR}/accounts`,
			entityFile: `${MODULES_DIR}/accounts/account.entity`,
			moduleFile: `${MODULES_DIR}/accounts/accounts.module.ts`,
			repositoryFile: `${MODULES_DIR}/accounts/account.repository.ts`,
		});
	});

	it('context: nests under <modules_dir>/<context>', () => {
		const n = entityModuleNaming({ name: 'transcript', plural: 'transcripts', context: 'integration' }, MODULES_DIR);
		expect(n.moduleDir).toBe(`${MODULES_DIR}/integration/transcripts`);
	});

	it('the declared plural wins over pluralize (person → persons, not people)', () => {
		expect(entityModuleNaming({ name: 'person', plural: 'persons' }, MODULES_DIR).moduleDir).toBe(
			`${MODULES_DIR}/persons`,
		);
		// Raw YAML without `plural:` falls back to pluralize.
		expect(entityModuleNaming({ name: 'person' }, MODULES_DIR).plural).toBe('people');
	});

	it('the barrels and the assemblies read it', () => {
		const entity = { name: 'transcript', plural: 'transcripts', context: 'integration' };
		const n = entityModuleNaming(entity, MODULES_DIR);
		const files = entityFilePaths(entity, { modules_dir: MODULES_DIR });
		expect(files.moduleFile).toBe(n.moduleFile);
		expect(files.schemaFile).toBe(`${n.entityFile}.ts`);
		const loc = resolveEntityModuleImports({
			entityName: entity.name,
			entityPlural: entity.plural,
			context: entity.context,
			surface: 'calendar',
			provider: 'google',
			backendSrcAbs: '/p/apps/backend/src',
			modulesAbs: path.join('/p', MODULES_DIR),
			aliases: {},
		});
		expect(loc.repoFileAbs).toBe(path.join('/p', n.repositoryFile));
		expect(loc.moduleFileAbs).toBe(path.join('/p', n.moduleFile));
	});
});
