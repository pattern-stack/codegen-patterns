/**
 * Resolved project paths for the hygen side.
 *
 * What is left here is what backend reads: the `paths` block's roots
 * (`BASE_PATHS`), the orchestration directory, the generated-barrel directory,
 * and the resolved config itself. Everything else this module used to export —
 * `BACKEND_LAYERS` and the `backend*` layer dirs, `getEntityPaths`,
 * `getImportPaths`, `getEntityFileNames`, `getLayoutConfig`, `FILE_NAMING`,
 * `computeFileName` / `computeFileNaming`, `getDatabaseDialect`,
 * `FOLDER_STRUCTURES` / `FILE_GROUPINGS` / `DEFAULT_LAYOUT` — existed to build
 * `templates/entity/new/prompt.js` locals that only the deleted `clean`
 * pipeline's templates read. ARCH-0 (#677) deleted those templates; ARCH-1
 * (#682) deletes this machinery and the config keys that fed it (`naming:`,
 * `database:`, `behaviors:`, `locations.backend*`, the entity layout keys).
 *
 * Usage:
 *   import { BASE_PATHS, getProjectConfig } from '../config/paths.mjs';
 */

import path from 'node:path';
import { resolvedConfig } from './config-loader.mjs';

// ============================================================================
// Path Configuration
// ============================================================================

/**
 * Base paths relative to project root, from the resolved `paths` block — every
 * default is declared once, in `PathsConfigSchema` (PATH-0, #642).
 */
export const BASE_PATHS = {
  backendSrc: resolvedConfig.paths.backend_src,
  // Where entity YAMLs live: `paths.entities` (#634 — one key, one reader).
  // Read by `loadOwnedTableNames` (#636), which runs inside the hygen prompt.
  entitiesDir: resolvedConfig.paths.entities,
  // The backend module tree (PATH-1, #645): `paths.modules_dir`,
  // default `<backend_src>/modules`.
  modulesDir: resolvedConfig.paths.modules_dir,
  // Orchestration emission root (ADR-032 Phase 3-2, O-6):
  // `paths.orchestration_src`, default `<backend_src>/orchestration`.
  orchestrationSrc: resolvedConfig.paths.orchestration_src,
};

const posixPath = path.posix;

function joinPath(...parts) {
  return posixPath.join(...parts.filter((part) => part !== '' && part != null));
}

/**
 * Get the orchestration emission directory (ADR-032 Phase 3-2).
 *
 * Honors `paths.orchestration_src`; defaults to `${backend_src}/orchestration`.
 * Returns a relative path (from project root). When `slug` is provided, joins
 * the per-pattern subdirectory (e.g. `crm-ports`).
 */
export function getOrchestrationPath(slug = '') {
  return slug
    ? joinPath(BASE_PATHS.orchestrationSrc, slug)
    : BASE_PATHS.orchestrationSrc;
}

/**
 * The resolved project configuration (the schema's defaults when there is no
 * file), for template access.
 */
export function getProjectConfig() {
  return resolvedConfig;
}

/**
 * The directory codegen writes cross-entity barrels to (modules.ts, schema.ts):
 * `paths.generated`, default `<backend_src>/generated`. Relative to the project
 * root.
 */
export function getGeneratedDir() {
  return resolvedConfig.paths.generated;
}

export default {
  BASE_PATHS,
  getOrchestrationPath,
  getProjectConfig,
  getGeneratedDir,
};
