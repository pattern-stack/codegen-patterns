/**
 * The backend module tree — the ONE rule for where an entity's module
 * lives: `<modules_dir>[/<context>]/<plural>` (PATH-1, #645; GEN-0, #649).
 *
 * Read by the hygen emission (`templates/_shared/entity-naming.mjs` re-exports
 * it), the barrels (`src/cli/shared/barrel-generator.ts` › `entityFilePaths`)
 * and the integration assemblies (`src/cli/shared/assembly-emission-generator.ts`
 * › `resolveEntityModuleImports`), so the three agree by construction
 * (charter I1).
 *
 * Ships in the package's `files` (the templates import it, `.ts` resolved by
 * bun), so it may import only node built-ins, runtime dependencies and other
 * shipped modules.
 */

import pluralize from 'pluralize';

/** The fields of an `entity:` block the tree reads. */
export interface ModuleTreeEntity {
	name: string;
	/** The declared plural; `pluralize(name)` for raw YAML that bypassed the schema (which requires it). */
	plural?: string;
	/** Bounded context: nests the module one level under `modules_dir` (#403). */
	context?: string | null;
}

export interface EntityModuleNaming {
	/** The Drizzle table export and the module folder's name. */
	plural: string;
	/** `<modules_dir>[/<context>]/<plural>` — the folder holding the entity's files. */
	moduleDir: string;
	/** The entity (+ Drizzle table) module, without extension. */
	entityFile: string;
	/** `<moduleDir>/<plural>.module.ts`. */
	moduleFile: string;
	/** `<moduleDir>/<name>.repository.ts`. */
	repositoryFile: string;
}

/**
 * An entity's module naming, from its OWN `entity:` block. `modulesDir` is the
 * module tree's root — the resolved `paths.modules_dir` (project-relative or
 * absolute; the result follows it).
 */
export function entityModuleNaming(entity: ModuleTreeEntity, modulesDir: string): EntityModuleNaming {
	const plural = entity.plural || pluralize.plural(entity.name);
	const moduleDir = entity.context ? `${modulesDir}/${entity.context}/${plural}` : `${modulesDir}/${plural}`;
	return {
		plural,
		moduleDir,
		entityFile: `${moduleDir}/${entity.name}.entity`,
		moduleFile: `${moduleDir}/${plural}.module.ts`,
		repositoryFile: `${moduleDir}/${entity.name}.repository.ts`,
	};
}
