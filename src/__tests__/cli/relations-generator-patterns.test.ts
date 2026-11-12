/**
 * READ-1 review (#859, A-B1) — the relations manifest's scope does not depend on
 * which command wrote it.
 *
 * The manifest folds the behaviors an entity's patterns imply into every hop,
 * `SCOPES` and `rootScope`. `relationship new` used to regenerate it without
 * loading the project's app patterns, so a pattern-implied `soft_delete` dropped
 * out of the scope whenever that command ran last. `regenerateRelationsManifest`
 * now owns the load, so every caller derives the same manifest, and the graph
 * builder refuses a pattern that is not registered rather than skipping it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { regenerateRelationsManifest } from '../../cli/shared/relations-generator.js';
import type { Context } from '../../cli/shared/context.js';
import { loadCodegenConfig } from '../../config/project-config.js';
import { buildRelationGraph } from '../../emitters/relations/build-graph.js';
import { loadRelationsEmitContext } from '../../emitters/relations/load-context.js';
import { _resetRegistryForTests } from '../../patterns/registry.js';
import '../../patterns/library/index.js';

const tempDirs: string[] = [];

afterEach(() => {
	// The registry is process-wide: drop the app pattern this file loaded.
	_resetRegistryForTests({ includeLibrary: false });
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
	tempDirs.length = 0;
});

const BARREL = path.resolve(import.meta.dir, '../../patterns/index.ts');

/** A project whose only entity declares an APP pattern that implies `soft_delete`. */
function mkProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relations-patterns-'));
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: entities\npatterns:\n  - src/patterns/*.pattern.ts\n');
	fs.mkdirSync(path.join(root, 'entities'));
	fs.writeFileSync(
		path.join(root, 'entities', 'note.yaml'),
		'entity:\n  name: note\n  plural: notes\n  pattern: ReadOneAppSoftDeleting\nfields:\n  body:\n    type: string\n',
	);
	fs.mkdirSync(path.join(root, 'src/patterns'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'src/patterns/soft.pattern.ts'),
		`import { definePattern } from '${BARREL}';
export const ReadOneAppSoftDeletingPattern = definePattern({
	name: 'ReadOneAppSoftDeleting',
	extends: ['Base'],
	repositoryClass: 'BaseRepository',
	serviceClass: 'BaseService',
	repositoryImport: '@shared/base-classes/base-repository',
	serviceImport: '@shared/base-classes/base-service',
	impliedBehaviors: ['soft_delete'],
});
`,
	);
	return root;
}

function context(root: string): Context {
	const configPath = path.join(root, 'codegen.config.yaml');
	return {
		cwd: root,
		configPath,
		config: loadCodegenConfig(configPath),
		isInitialized: true,
		framework: null,
		installedSubsystems: [],
		entityCount: 1,
		json: false,
		verbose: false,
	} as Context;
}

describe('the relations manifest owns the app-pattern load', () => {
	test('a fresh registry still yields the pattern-implied scope', async () => {
		const root = mkProject();
		_resetRegistryForTests({ includeLibrary: false });

		const { content } = await regenerateRelationsManifest({
			ctx: context(root),
			entitiesDir: path.join(root, 'entities'),
			generatedDir: path.join(root, 'generated'),
			dryRun: true,
		});

		expect(content).toContain(
			"softDelete: true, userTracking: false, enforcement: 'lenient' });",
		);
		expect(content).toContain('\tnotes: NOTES_SCOPE,');
	});

	test('the graph builder throws on an unregistered pattern instead of narrowing the scope', () => {
		const root = mkProject();
		_resetRegistryForTests({ includeLibrary: false });
		const { ctx } = loadRelationsEmitContext(root, loadCodegenConfig(path.join(root, 'codegen.config.yaml')), {
			entitiesDir: path.join(root, 'entities'),
		});
		expect(() => buildRelationGraph(ctx)).toThrow(
			"entity 'note' declares pattern 'ReadOneAppSoftDeleting', which is not registered",
		);
	});
});
