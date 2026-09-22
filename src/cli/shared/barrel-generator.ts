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

import fs from 'node:fs';
import path from 'node:path';

import pluralize from 'pluralize';

import { findYamlFiles } from '../../utils/find-yaml-files';

import type { Context } from './context.js';
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BarrelGeneratorOptions {
	ctx: Context;
	/** Absolute path to the entities directory. */
	entitiesDir: string;
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
}

export interface BarrelResult {
	modulesBarrel: string;
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
	 * #403: bounded-context segment. When set, the entity's clean-lite-ps
	 * module folder is nested under `modules/<context>/<plural>/` so the barrel
	 * import path must include it. Relationships and junctions never carry a
	 * context, so they stay flat.
	 */
	context?: string;
}

// ---------------------------------------------------------------------------
// Case helpers — intentionally local to avoid a dependency on case-converters.mjs
// from a TS module. Identical semantics for the snake/kebab → Pascal case path
// we actually exercise here.
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

export function listEntityYamls(entitiesDir: string): string[] {
	if (!fs.existsSync(entitiesDir)) return [];
	return findYamlFiles(entitiesDir);
}

function collectEntities(entitiesDir: string): EntityInfo[] {
	const files = listEntityYamls(entitiesDir);
	const entities: EntityInfo[] = [];
	for (const file of files) {
		const result = loadEntityFromYaml(file);
		if (!result.success) continue;
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
function listRelationshipYamls(relationshipsDir: string): string[] {
	if (!fs.existsSync(relationshipsDir)) return [];
	return findYamlFiles(relationshipsDir).filter(
		(full) => detectYamlType(full) === 'relationship',
	);
}

function collectRelationships(relationshipsDir: string): EntityInfo[] {
	const files = listRelationshipYamls(relationshipsDir);
	const junctions: EntityInfo[] = [];
	for (const file of files) {
		const result = loadRelationshipFromYaml(file);
		if (!result.success) continue;
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
	const files = listJunctionYamls(junctionsDir);
	const junctions: EntityInfo[] = [];
	for (const file of files) {
		const result = loadJunctionFromYaml(file);
		if (!result.success) continue;
		const def = result.definition;
		const name = deriveJunctionName(def);
		const plural = pluralize(name);
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
 * the clean-lite-ps module tree, `entityModuleNaming` (src/config/module-tree.ts,
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

const HEADER = `// AUTO-GENERATED by @pattern-stack/codegen. Do not edit.\n// Run \`codegen entity new --all\` to refresh.\n\n`;

function relativeImport(fromFile: string, toFile: string): string {
	// Both paths are relative to project root.
	const fromDir = path.posix.dirname(fromFile);
	let rel = path.posix.relative(fromDir, toFile);
	if (!rel.startsWith('.')) rel = `./${rel}`;
	// Strip .ts extension for TS imports.
	return rel.replace(/\.ts$/, '');
}

export function buildModulesBarrel(
	entities: EntityInfo[],
	barrelFile: string,
	paths: BarrelPaths
): string {
	const imports: string[] = [];
	const exportsList: string[] = [];

	for (const ent of entities) {
		const { moduleFile, moduleClass } = entityFilePaths(ent, paths);
		const importPath = relativeImport(barrelFile, moduleFile);
		imports.push(`import { ${moduleClass} } from '${importPath}';`);
		exportsList.push(moduleClass);
	}

	if (entities.length === 0) {
		return `${HEADER}export const GENERATED_MODULES = [] as const;\n`;
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
		relationshipsDir = path.resolve(ctx.cwd, 'relationships'),
		junctionsDir = path.resolve(ctx.cwd, 'junctions'),
		generatedDir,
		dryRun = false,
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
	const entities = generating(modulesAbs, () =>
		[
			...collectEntities(entitiesDir),
			...collectRelationships(relationshipsDir),
			...collectJunctions(junctionsDir),
		].sort((a, b) => a.name.localeCompare(b.name)),
	);
	const modulesContent = generating(modulesAbs, () =>
		buildModulesBarrel(entities, modulesRel, paths),
	);
	const schemaContent = generating(schemaAbs, () =>
		buildSchemaBarrel(entities, schemaRel, paths),
	);

	let written = false;
	if (!dryRun) {
		generating(modulesAbs, () => {
			fs.mkdirSync(path.dirname(modulesAbs), { recursive: true });
			fs.writeFileSync(modulesAbs, modulesContent);
		});
		generating(schemaAbs, () => fs.writeFileSync(schemaAbs, schemaContent));
		written = true;
	}

	return {
		modulesBarrel: modulesAbs,
		schemaBarrel: schemaAbs,
		entityCount: entities.length,
		modulesContent,
		schemaContent,
		written,
	};
}
