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
import {
	loadEntityFromYaml,
	loadRelationshipFromYaml,
	loadJunctionFromYaml,
	detectYamlType,
} from '../../utils/yaml-loader.js';
import type { EntityDefinition } from '../../schema/entity-definition.schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Architecture = 'clean' | 'clean-lite-ps';

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
	/** Architecture flavor — drives where entity modules live on disk. */
	architecture: Architecture;
	/**
	 * Backend source root, relative to project root. Used to compute module
	 * file paths for the 'clean' architecture. Ignored for 'clean-lite-ps'.
	 * Defaults to 'app/backend/src' to match src/config/locations.mjs.
	 */
	backendSrc?: string;
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

interface EntityInfo {
	name: string;
	plural: string;
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

function toKebabCase(input: string): string {
	return input
		.replace(/([a-z])([A-Z])/g, '$1-$2')
		.replace(/[_\s]+/g, '-')
		.toLowerCase();
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

/**
 * Derive the junction name from a JunctionDefinition.
 * Q8 resolution: insertion order — between: [opportunity, contact] → 'opportunity_contact'.
 * Explicit `name:` on the YAML overrides the derivation.
 */
function deriveJunctionName(def: { name?: string; between: [string, string] }): string {
	return def.name ?? `${def.between[0]}_${def.between[1]}`;
}

function collectJunctions(junctionsDir: string): EntityInfo[] {
	const files = listJunctionYamls(junctionsDir);
	const junctions: EntityInfo[] = [];
	for (const file of files) {
		const result = loadJunctionFromYaml(file);
		if (!result.success) continue;
		const def = result.definition;
		const name = deriveJunctionName(def);
		const plural = def.table ?? pluralize(name);
		junctions.push({ name, plural });
	}
	junctions.sort((a, b) => a.name.localeCompare(b.name));
	return junctions;
}

// ---------------------------------------------------------------------------
// Path computation per architecture
// ---------------------------------------------------------------------------

/**
 * Where each entity's module + schema file lives, relative to project root.
 *
 * Must match the output of the actual Hygen templates:
 *   - clean-lite-ps:  modules/<plural>/<plural>.module.ts
 *                     modules/<plural>/<name>.entity.ts
 *   - clean:          src/infrastructure/modules/<plural>.module.ts
 *                     src/infrastructure/persistence/drizzle/<plural>.schema.ts
 *
 * Note: the `clean` paths mirror the defaults in src/config/locations.mjs and
 * the backend template set's output paths. If a project overrides those via
 * `locations:` in codegen.config.yaml, the barrel will still point at the
 * default locations — a known limitation documented in ADR-017.
 */
function entityFilePaths(
	info: EntityInfo,
	architecture: Architecture,
	backendSrc: string
): {
	moduleFile: string;
	moduleClass: string;
	schemaFile: string;
} {
	const name = info.name;
	const plural = info.plural;
	const nameKebab = toKebabCase(name);
	const pluralKebab = toKebabCase(plural);

	if (architecture === 'clean-lite-ps') {
		// Clean-Lite-PS templates emit directories/files using the raw snake_case
		// `plural`/`name` values, prefixed with `paths.backend_src` (see
		// templates/entity/new/clean-lite-ps/prompt-extension.js — `srcRoot`).
		// The barrel must match that on-disk layout.
		const prefix = backendSrc && backendSrc !== '.' ? `${backendSrc}/` : '';
		return {
			moduleFile: `${prefix}modules/${plural}/${plural}.module.ts`,
			moduleClass: `${toPascalCase(plural)}Module`,
			// Drizzle entity schema lives alongside the entity file in clean-lite-ps.
			schemaFile: `${prefix}modules/${plural}/${name}.entity.ts`,
		};
	}

	// 'clean' — full Clean Architecture. Paths mirror src/config/locations.mjs
	// defaults; a `paths.backend_src` override in codegen.config.yaml is honored
	// via the `backendSrc` parameter.
	return {
		moduleFile: `${backendSrc}/infrastructure/modules/${pluralKebab}.module.ts`,
		moduleClass: `${toPascalCase(plural)}Module`,
		schemaFile: `${backendSrc}/infrastructure/persistence/drizzle/${pluralKebab}.schema.ts`,
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
	architecture: Architecture,
	backendSrc: string = 'app/backend/src'
): string {
	const imports: string[] = [];
	const exportsList: string[] = [];

	for (const ent of entities) {
		const { moduleFile, moduleClass } = entityFilePaths(ent, architecture, backendSrc);
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
	architecture: Architecture,
	backendSrc: string = 'app/backend/src'
): string {
	if (entities.length === 0) {
		return `${HEADER}export {};\n`;
	}

	const lines = entities.map((ent) => {
		const { schemaFile } = entityFilePaths(ent, architecture, backendSrc);
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
		architecture,
		backendSrc = resolveBackendSrc(ctx),
		dryRun = false,
	} = opts;
	const cwd = ctx.cwd;

	// Entities, relationship modules, and junction modules all produce peer
	// modules on disk — merge all three into the same deterministic list so the
	// generated barrel reflects the full module graph. Relationships and junctions
	// are silently skipped if their dirs don't exist (the common case for projects
	// that haven't generated any yet).
	//
	// All three feed through entityFilePaths() so the import-depth fix from
	// commit 01bb917 covers junctions automatically.
	const entities = [
		...collectEntities(entitiesDir),
		...collectRelationships(relationshipsDir),
		...collectJunctions(junctionsDir),
	].sort((a, b) => a.name.localeCompare(b.name));

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

	const modulesContent = buildModulesBarrel(entities, modulesRel, architecture, backendSrc);
	const schemaContent = buildSchemaBarrel(entities, schemaRel, architecture, backendSrc);

	const modulesAbs = path.resolve(cwd, modulesRel);
	const schemaAbs = path.resolve(cwd, schemaRel);

	let written = false;
	if (!dryRun) {
		fs.mkdirSync(path.dirname(modulesAbs), { recursive: true });
		fs.writeFileSync(modulesAbs, modulesContent);
		fs.writeFileSync(schemaAbs, schemaContent);
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

/**
 * Resolve the architecture to target from a context's loaded config.
 * Honors `generate.architecture`, falling back to 'clean'.
 */
export function resolveArchitecture(ctx: Context): Architecture {
	const cfg = ctx.config as
		| { generate?: { architecture?: string } }
		| null
		| undefined;
	const raw = cfg?.generate?.architecture;
	return raw === 'clean-lite-ps' ? 'clean-lite-ps' : 'clean';
}

/**
 * Resolve the absolute generated directory from a context.
 * Honors `paths.generated`, falling back to `<cwd>/src/generated`.
 */
export function resolveGeneratedDir(ctx: Context): string {
	const fromConfig = (ctx.config as { paths?: { generated?: string } } | null | undefined)
		?.paths?.generated;
	const rel = typeof fromConfig === 'string' && fromConfig.length > 0
		? fromConfig
		: 'src/generated';
	return path.resolve(ctx.cwd, rel);
}

/**
 * Resolve backend_src from config.
 *
 * Default differs by architecture:
 *   - clean: 'app/backend/src' (matches src/config/locations.mjs)
 *   - clean-lite-ps: 'src' (matches the init-scaffold layout)
 *
 * The architecture isn't visible here, so we keep the historical 'app/backend/src'
 * default for backwards compatibility. Callers in the clean-lite-ps path pass
 * 'src' (or whatever paths.backend_src declares) explicitly.
 */
export function resolveBackendSrc(ctx: Context): string {
	const fromConfig = (ctx.config as { paths?: { backend_src?: string } } | null | undefined)
		?.paths?.backend_src;
	return typeof fromConfig === 'string' && fromConfig.length > 0
		? fromConfig
		: 'app/backend/src';
}
