/**
 * Barrel generator — writes codegen-owned barrel files that aggregate every
 * entity's NestJS module and Drizzle entity schema.
 *
 * Context (see ADR-017): Hygen injects into user-authored `app.module.ts` and
 * `schema.ts` were fragile — they corrupted files silently when the anchors
 * weren't where the template expected. We now own two files instead:
 *
 *   <generated>/modules.ts — exports a frozen array of every entity module
 *   <generated>/schema.ts  — re-exports every entity's drizzle schema file
 *
 * The user wires these up exactly once:
 *
 *   // app.module.ts
 *   import { GENERATED_MODULES } from './generated/modules';
 *   @Module({ imports: [DatabaseModule, ...GENERATED_MODULES] })
 *
 *   // schema.ts
 *   export * from './generated/schema';
 *
 * Every `entity new` / `entity new --all` invocation fully regenerates both
 * barrels from the full entity set. Deterministic, no state tracking, no
 * mutation of user files.
 */

import { CODEGEN_BANNER } from '../../utils/generated-file.js';
import { relativeImport } from '../../utils/import-path.js';
import fs from 'node:fs';
import path from 'node:path';

import pluralize from 'pluralize';
import { junctionPlural } from '../../config/junction-naming.js';
import { junctionsDirFor, relationshipsDirFor } from '../../config/junctions-dir.js';

import { findYamlFiles, listEntityYamls } from '../../utils/find-yaml-files';

import type { Context } from './context.js';
import { resolveRuntimeMode, runtimeImport, type RuntimeMode } from './runtime-import.js';
import { entityModuleNaming } from '../../config/module-tree.js';
import { configOrDefaults } from '../../config/project-config.js';
import {
	loadEntityFromYaml,
	loadRelationshipFromYaml,
	loadJunctionFromYaml,
	detectYamlType,
} from '../../utils/yaml-loader.js';
import type { EntityDefinition } from '../../schema/entity-definition.schema.js';
import type { PathsConfig } from '../../schema/codegen-config.schema.js';
import { deriveJunctionName } from '../../schema/junction-definition.schema.js';
import { generating } from '../../utils/generated-file.js';
import { invalidDefinitionError, relationshipFileFailure } from '../../utils/definition-invariant.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BarrelGeneratorOptions {
	ctx: Context;
	/** Absolute path to the entities directory. */
	entitiesDir: string;
	/** Other definition kinds under the entities root (`ProjectLayout.nonEntityDirs`); skipped by entity discovery. */
	nonEntityDirs: string[];
	/**
	 * Absolute path to the relationships directory. Optional — when present
	 * relationship modules are included in the generated barrels alongside entity
	 * modules. Falls back to <cwd>/relationships when omitted.
	 */
	relationshipsDir?: string;
	/**
	 * Absolute path to the junctions directory. Optional — when present
	 * junction modules are included in the generated barrels alongside entity
	 * and relationship modules. Falls back to <cwd>/junctions when omitted.
	 */
	junctionsDir?: string;
	/** Absolute path to the directory the barrels should be written into. */
	generatedDir: string;
	/** If true, compute content but don't touch the filesystem. */
	dryRun?: boolean;
	/** Write `modules.ts` (the Nest modules barrel). False for a storage-only target (TGT-2b). Default true. */
	modulesBarrel?: boolean;
	/**
	 * Put the junctions' tables in the schema barrel. Defaults to `modulesBarrel`; plain wiring (PW-3c) writes no
	 * modules barrel but has junctions.
	 */
	junctions?: boolean;
}

export interface BarrelResult {
	modulesBarrel: string;
	/** False when the modules barrel was not written (a storage-only target, TGT-2b): `modulesBarrel` is then unused. */
	modulesBarrelWritten: boolean;
	schemaBarrel: string;
	entityCount: number;
	/** Planned file contents — always populated, useful for dry-run reports. */
	modulesContent: string;
	schemaContent: string;
	/** True when the barrels were actually written to disk. */
	written: boolean;
}

export interface EntityInfo {
	name: string;
	plural: string;
	/**
	 * #403: bounded-context segment. When set, the entity's backend
	 * module folder is nested under `modules/<context>/<plural>/` so the barrel
	 * import path must include it. Relationships and junctions never carry a
	 * context, so they stay flat.
	 */
	context?: string;
}

// ---------------------------------------------------------------------------
// Case helpers — local. `src/config/file-naming.ts` owns the FILE-NAME rule
// (NAME-2) and is imported wherever a path is built; this is identifier casing
// for a class name, a different question, so it stays here rather than growing
// that module a second responsibility. (The old justification named
// `case-converters.mjs`, which NAME-2 deleted once it had no importers.)
// ---------------------------------------------------------------------------

function toPascalCase(input: string): string {
	return input
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join('');
}

// ---------------------------------------------------------------------------
// Entity discovery
// ---------------------------------------------------------------------------

function collectEntities(entitiesDir: string, nonEntityDirs: readonly string[]): EntityInfo[] {
	const files = listEntityYamls(entitiesDir, nonEntityDirs);
	const entities: EntityInfo[] = [];
	for (const file of files) {
		const result = loadEntityFromYaml(file);
		if (!result.success) throw invalidDefinitionError(result);
		const def: EntityDefinition = result.definition;
		entities.push({
			name: def.entity.name,
			plural: def.entity.plural,
			// #403: `entity.context:` nests the module folder; undefined → flat.
			context: def.entity.context,
		});
	}
	// Deterministic: sort by singular name.
	entities.sort((a, b) => a.name.localeCompare(b.name));
	return entities;
}

/**
 * Discover relationship YAML files and return them in the same shape as
 * entities. Relationships produce a junction module that lives alongside
 * regular modules on disk — so for barrel purposes they're peers.
 *
 * The junction's `plural` is its `table` name when declared, otherwise
 * derived via the `pluralize` library (handles irregular English plurals
 * like category→categories). Matches the convention in
 * templates/relationship/new/prompt.js `deriveTableName()`.
 */
function collectRelationships(relationshipsDir: string): EntityInfo[] {
	const files = fs.existsSync(relationshipsDir) ? findYamlFiles(relationshipsDir) : [];
	const junctions: EntityInfo[] = [];
	for (const file of files) {
		const result = loadRelationshipFromYaml(file);
		if (!result.success) {
			// A file that is not a relationship (no `relationship:` key) is not this
			// step's; one that is, or that does not even parse, is a rejection.
			if (relationshipFileFailure(file, false, result)) throw invalidDefinitionError(result);
			continue;
		}
		const rel = result.definition.relationship;
		const name = rel.name;
		const plural = rel.table ?? pluralize(name);
		junctions.push({ name, plural });
	}
	junctions.sort((a, b) => a.name.localeCompare(b.name));
	return junctions;
}

/**
 * Discover junction YAML files and return them in the same shape as entities.
 * Junction modules are peer modules to entity and relationship modules in the
 * barrel — the import-depth fix from commit 01bb917 covers them automatically
 * because all three feed through the same entityFilePaths() codepath.
 */
export function listJunctionYamls(junctionsDir: string): string[] {
	if (!fs.existsSync(junctionsDir)) return [];
	return findYamlFiles(junctionsDir).filter(
		(full) => detectYamlType(full) === 'junction',
	);
}

function collectJunctions(junctionsDir: string): EntityInfo[] {
	// Every YAML under junctions/ is a junction definition (`loadJunctionSet`'s rule).
	const files = fs.existsSync(junctionsDir) ? findYamlFiles(junctionsDir) : [];
	const junctions: EntityInfo[] = [];
	for (const file of files) {
		const result = loadJunctionFromYaml(file);
		if (!result.success) throw invalidDefinitionError(result);
		const def = result.definition;
		const name = deriveJunctionName(def);
		const plural = junctionPlural(name);
		junctions.push({ name, plural });
	}
	junctions.sort((a, b) => a.name.localeCompare(b.name));
	return junctions;
}

// ---------------------------------------------------------------------------
// Path computation
// ---------------------------------------------------------------------------

/** The resolved `paths.*` key the barrel's module paths read. */
export type BarrelPaths = Pick<PathsConfig, 'modules_dir'>;

/**
 * Where each entity's module + schema file lives, relative to project root —
 * the backend module tree, `entityModuleNaming` (src/config/module-tree.ts,
 * GEN-0 #649): <modules_dir>[/<context>]/<plural>/{<plural>.module,<name>.entity}.ts
 */
export function entityFilePaths(
	info: EntityInfo,
	paths: BarrelPaths
): {
	moduleFile: string;
	moduleClass: string;
	schemaFile: string;
} {
	const naming = entityModuleNaming(info, paths.modules_dir);
	return {
		moduleFile: naming.moduleFile,
		moduleClass: `${toPascalCase(info.plural)}Module`,
		// The Drizzle table lives in the entity file.
		schemaFile: `${naming.entityFile}.ts`,
	};
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

const HEADER = `${CODEGEN_BANNER}\n\n`;

/**
 * The runtime module the barrel lists first: the global filter that answers a foreign-key or unique violation with
 * a 4xx instead of a 500 (`runtime/nest-db-constraint-filter.ts`). In the barrel because the barrel is the one
 * generated file every app imports into its `AppModule`, so regenerating is enough to get it.
 */
const DB_CONSTRAINT_MODULE = 'DbConstraintErrorsModule';
const DB_CONSTRAINT_RUNTIME_PATH = 'nest-db-constraint-filter';

export function buildModulesBarrel(
	entities: EntityInfo[],
	barrelFile: string,
	paths: BarrelPaths,
	runtimeMode: RuntimeMode,
): string {
	const imports: string[] = [
		`import { ${DB_CONSTRAINT_MODULE} } from '${runtimeImport(runtimeMode, DB_CONSTRAINT_RUNTIME_PATH)}';`,
	];
	const exportsList: string[] = [DB_CONSTRAINT_MODULE];

	for (const ent of entities) {
		const { moduleFile, moduleClass } = entityFilePaths(ent, paths);
		const importPath = relativeImport(barrelFile, moduleFile);
		imports.push(`import { ${moduleClass} } from '${importPath}';`);
		exportsList.push(moduleClass);
	}


	const body =
		imports.join('\n') +
		'\n\n' +
		`export const GENERATED_MODULES = [\n${exportsList
			.map((n) => `\t${n},`)
			.join('\n')}\n] as const;\n`;

	return HEADER + body;
}

export function buildSchemaBarrel(
	entities: EntityInfo[],
	barrelFile: string,
	paths: BarrelPaths
): string {
	if (entities.length === 0) {
		return `${HEADER}export {};\n`;
	}

	const lines = entities.map((ent) => {
		const { schemaFile } = entityFilePaths(ent, paths);
		return `export * from '${relativeImport(barrelFile, schemaFile)}';`;
	});

	return HEADER + lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function regenerateBarrels(
	opts: BarrelGeneratorOptions
): Promise<BarrelResult> {
	const {
		ctx,
		entitiesDir,
		nonEntityDirs,
		relationshipsDir = relationshipsDirFor(ctx.cwd),
		junctionsDir = junctionsDirFor(ctx.cwd),
		generatedDir,
		dryRun = false,
		modulesBarrel = true,
		junctions = modulesBarrel,
	} = opts;
	const cwd = ctx.cwd;
	// The resolved `paths` block (PATH-0): `modules_dir` places the modules.
	const paths = configOrDefaults(ctx.config).paths;

	// Compute barrel paths relative to project root so imports line up.
	const generatedRel = path.relative(cwd, generatedDir) || path.basename(generatedDir);
	const modulesRel = path.posix.join(
		generatedRel.split(path.sep).join('/'),
		'modules.ts'
	);
	const schemaRel = path.posix.join(
		generatedRel.split(path.sep).join('/'),
		'schema.ts'
	);

	const modulesAbs = path.resolve(cwd, modulesRel);
	const schemaAbs = path.resolve(cwd, schemaRel);

	// JOBS-0 (#655): the app imports both barrels — a failure names the file.
	//
	// Entities, relationship modules, and junction modules all produce peer
	// modules on disk — merge all three into the same deterministic list so the
	// generated barrel reflects the full module graph. Relationships and junctions
	// are silently skipped if their dirs don't exist (the common case for projects
	// that haven't generated any yet).
	//
	// All three feed through entityFilePaths() so the import-depth fix from
	// commit 01bb917 covers junctions automatically.
	// A storage-only target (TGT-2b) has entity tables only: `junction new` / `relationship new` refuse it, so their
	// modules are not in its barrel. Plain wiring (PW-3c) has junction tables but no relationship pipeline yet.
	const entities = generating(modulesAbs, () =>
		[
			...collectEntities(entitiesDir, nonEntityDirs),
			...(modulesBarrel ? collectRelationships(relationshipsDir) : []),
			...(junctions ? collectJunctions(junctionsDir) : []),
		].sort((a, b) => a.name.localeCompare(b.name)),
	);
	const modulesContent = generating(modulesAbs, () =>
		buildModulesBarrel(entities, modulesRel, paths, resolveRuntimeMode(ctx.config)),
	);
	const schemaContent = generating(schemaAbs, () =>
		buildSchemaBarrel(entities, schemaRel, paths),
	);

	let written = false;
	if (!dryRun) {
		generating(schemaAbs, () => fs.mkdirSync(path.dirname(schemaAbs), { recursive: true }));
		// A storage-only target (TGT-2b) has no Nest modules to import, so no modules barrel.
		if (modulesBarrel) generating(modulesAbs, () => fs.writeFileSync(modulesAbs, modulesContent));
		generating(schemaAbs, () => fs.writeFileSync(schemaAbs, schemaContent));
		written = true;
	}

	return {
		modulesBarrel: modulesAbs,
		modulesBarrelWritten: modulesBarrel && !dryRun,
		schemaBarrel: schemaAbs,
		entityCount: entities.length,
		modulesContent,
		schemaContent,
		written,
	};
}
