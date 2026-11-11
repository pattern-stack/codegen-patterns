/**
 * Semantic emitter — config + registry → emit context (SEM-2, ADR-045).
 *
 * `loadSemanticEmitContext` is the single place the CLI post-step calls to turn
 * a loaded `codegen.config.yaml` into a ready-to-emit {@link SemanticEmitContext}
 * plus the output directory. Reads paths off the in-hand config rather than a
 * cwd-bound singleton, like the frontend and relations loaders.
 *
 * A zero-entity project IS a skip, unlike the relations manifest: no emitted
 * file imports the semantic model, so an absent directory is the correct state
 * for a project with nothing to describe.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ParsedEntity } from '../../analyzer/types';
import { loadEntityRegistry, type EntityRegistryEntry } from '../../parser/entity-registry';
import { loadEntities } from '../../parser/load-entities';
import type { JunctionDefinition } from '../../schema/junction-definition.schema';
import { findYamlFiles } from '../../utils/find-yaml-files';
import { detectYamlType, loadJunctionFromYaml } from '../../utils/yaml-loader';
import { junctionName } from '../../config/junction-naming.js';
import { sortEntities, type SemanticEmitContext } from './types';
import { TablesConfigSchema, TenancyConfigSchema } from '../../schema/codegen-config.schema';

/**
 * Directory names, not `paths.*` defaults: the caller resolves those from the
 * schema (PATH-0, #642). These are the standalone-emitter fallback for a
 * caller that passes no config at all.
 */
const ENTITIES_DIRNAME = 'entities';
const JUNCTIONS_DIRNAME = 'junctions';
const GENERATED_DIRNAME = 'src/generated';

/** The slice of `codegen.config.yaml` this loader reads. */
export interface SemanticConfigInput {
	paths?: {
		/** CFG-0 (#640) declares this as `paths.entities`; `entities_dir` is gone. */
		entities?: string;
		generated?: string;
		[key: string]: unknown;
	};
	/** #791 — the project's default tenant column; its role is dimension. */
	tenancy?: { column?: string };
	/** TABLE-0 — the project's SQL table prefix; each entity's `tableName` is the resolved SQL name. */
	tables?: { prefix?: string };
	generate?: {
		semantic?: unknown;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export type LoadSemanticEmitContextResult =
	| { skip: string; ctx?: undefined; outDir?: undefined }
	| { skip?: undefined; ctx: SemanticEmitContext; outDir: string };

/** Sub-directory of `paths.generated` the semantic model is written into. */
export const SEMANTIC_OUT_SUBDIR = 'semantic';

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
		junctionName(a.between).localeCompare(junctionName(b.between)),
	);
}

/**
 * Build the semantic emit context from a project root + loaded config.
 *
 * @param cwd     Project root (the CLI's `--cwd`, NOT `process.cwd()`).
 * @param config  The loaded `codegen.config.yaml`.
 */
export function loadSemanticEmitContext(
	cwd: string,
	config: SemanticConfigInput | null | undefined,
	opts: { entitiesDir?: string; junctionsDir?: string } = {},
): LoadSemanticEmitContextResult {
	const entitiesDir =
		opts.entitiesDir ?? path.resolve(cwd, config?.paths?.entities ?? ENTITIES_DIRNAME);
	const junctionsDir = opts.junctionsDir ?? path.resolve(cwd, JUNCTIONS_DIRNAME);

	const tablePrefix = TablesConfigSchema.parse(config?.tables ?? {}).prefix;
	const { registry } = loadEntityRegistry(entitiesDir, { tablePrefix });
	const entities: EntityRegistryEntry[] = sortEntities([...registry.values()]);

	if (entities.length === 0) {
		return {
			skip: `no entities found in ${path.relative(cwd, entitiesDir) || entitiesDir}`,
		};
	}

	const parsed = new Map<string, ParsedEntity>(
		loadEntities(entitiesDir, { tablePrefix }).entities.map((entity) => [entity.name, entity]),
	);

	const outDir = path.resolve(
		cwd,
		config?.paths?.generated ?? GENERATED_DIRNAME,
		SEMANTIC_OUT_SUBDIR,
	);

	return {
		skip: undefined,
		ctx: {
			entities,
			parsed,
			junctions: loadJunctionDefinitions(junctionsDir),
			tenancyColumn: TenancyConfigSchema.parse(config?.tenancy ?? {}).column,
			tablePrefix,
		},
		outDir,
	};
}
