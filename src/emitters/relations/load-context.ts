/**
 * Relations emitter — config + registry → emit context (ADR-044, REL-1).
 *
 * `loadRelationsEmitContext` is the single place the CLI post-steps call to turn
 * a loaded `codegen.config.yaml` into a ready-to-emit {@link RelationsEmitContext}
 * plus the output directory. Like the frontend loader it reads paths off the
 * in-hand config rather than a cwd-bound singleton.
 *
 * Unlike the frontend loader, a zero-entity project is NOT a skip: the emitted
 * `database.module.ts` imports the manifest unconditionally, so an empty
 * manifest still has to exist.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadEntityRegistry } from '../../parser/entity-registry';
import type { EntityDefinition } from '../../schema/entity-definition.schema';
import type { JunctionDefinition } from '../../schema/junction-definition.schema';
import { findYamlFiles } from '../../utils/find-yaml-files';
import {
	detectYamlType,
	loadEntityFromYaml,
	loadJunctionFromYaml,
} from '../../utils/yaml-loader';
import { junctionIdentity } from './build-graph';
import { sortEntities, type RelationsEmitContext } from './types';

/** The slice of `codegen.config.yaml` this loader reads. */
export interface RelationsConfigInput {
	paths?: {
		/** CFG-0 (#640) declares this as `paths.entities`. */
		entities?: string;
		generated?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface LoadRelationsEmitContextResult {
	ctx: RelationsEmitContext;
	/** Absolute directory the manifest is written into (`paths.generated`). */
	outDir: string;
}

/** Load every junction YAML under `junctionsDir`, sorted by derived name. */
export function loadJunctionDefinitions(junctionsDir: string): JunctionDefinition[] {
	if (!existsSync(junctionsDir) || !statSync(junctionsDir).isDirectory()) return [];
	const defs: JunctionDefinition[] = [];
	for (const file of findYamlFiles(junctionsDir)) {
		if (detectYamlType(file) !== 'junction') continue;
		const result = loadJunctionFromYaml(file);
		if (!result.success) continue;
		defs.push(result.definition);
	}
	return defs.sort((a, b) =>
		junctionIdentity(a).name.localeCompare(junctionIdentity(b).name),
	);
}

/** Load every entity YAML under `entitiesDir` as a raw definition, keyed by name. */
export function loadEntityDefinitions(
	entitiesDir: string,
): Map<string, EntityDefinition> {
	const defs = new Map<string, EntityDefinition>();
	if (!existsSync(entitiesDir) || !statSync(entitiesDir).isDirectory()) return defs;
	for (const file of findYamlFiles(entitiesDir)) {
		const result = loadEntityFromYaml(file);
		if (!result.success) continue;
		defs.set(result.definition.entity.name, result.definition);
	}
	return defs;
}

/**
 * Build the relations emit context from a project root + loaded config.
 *
 * @param cwd     Project root (the CLI's `--cwd`, NOT `process.cwd()`).
 * @param config  The loaded `codegen.config.yaml`.
 */
export function loadRelationsEmitContext(
	cwd: string,
	config: RelationsConfigInput | null | undefined,
	opts: { entitiesDir?: string; junctionsDir?: string } = {},
): LoadRelationsEmitContextResult {
	const entitiesDir =
		opts.entitiesDir ?? path.resolve(cwd, config?.paths?.entities ?? 'entities');
	const junctionsDir = opts.junctionsDir ?? path.resolve(cwd, 'junctions');
	const outDir = path.resolve(cwd, config?.paths?.generated ?? 'src/generated');

	const { registry } = loadEntityRegistry(entitiesDir);

	return {
		ctx: {
			entities: sortEntities([...registry.values()]),
			definitions: loadEntityDefinitions(entitiesDir),
			junctions: loadJunctionDefinitions(junctionsDir),
		},
		outDir,
	};
}
