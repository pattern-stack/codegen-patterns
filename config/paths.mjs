/**
 * Centralized path configuration for codegen
 *
 * All generated file paths are defined here to make it easy to update
 * the architecture structure without hunting through multiple files.
 *
 * Usage:
 *   import { paths, getPath } from '../config/paths.js';
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Load project-specific codegen configuration from codegen.config.yaml
 * Returns null if config file doesn't exist (falls back to defaults)
 */
function loadProjectConfig(cwd = process.cwd()) {
  const configPath = path.resolve(cwd, 'codegen.config.yaml');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return yaml.parse(content);
  } catch (error) {
    console.warn(`Warning: Failed to load codegen.config.yaml: ${error.message}`);
    return null;
  }
}

// Load project config once at module initialization
const projectConfig = loadProjectConfig();

// ============================================================================
// Layout Options
// ============================================================================

/**
 * Folder structure options - controls directory nesting
 */
export const FOLDER_STRUCTURES = {
  nested: "nested",   // domain/opportunity/opportunity.entity.ts
  flat: "flat",       // domain/opportunity.entity.ts
};

/**
 * File grouping options - controls how related code is organized into files
 * This is orthogonal to folder_structure (layout vs content organization)
 */
export const FILE_GROUPINGS = {
  separate: "separate", // Each concern in its own file (entity.ts, repository.interface.ts)
  grouped: "grouped",   // Related concerns combined (index.ts with entity + interface)
};

/**
 * Default layout configuration
 */
export const DEFAULT_LAYOUT = {
  folderStructure: FOLDER_STRUCTURES.nested,
  fileGrouping: FILE_GROUPINGS.separate,
};

// ============================================================================
// Path Configuration
// ============================================================================

/**
 * Base paths relative to project root
 * Can be overridden by codegen.config.yaml
 */
export const BASE_PATHS = {
  // Backend base
  backendSrc: projectConfig?.paths?.backend_src ?? "app/backend/src",

  // Frontend base
  frontendSrc: projectConfig?.paths?.frontend_src ?? "app/frontend/src",

  // Shared packages
  packages: projectConfig?.paths?.packages ?? "packages",

  // Schema directory (relative to backendSrc)
  schemaDir: projectConfig?.paths?.schema_dir ?? "infrastructure/persistence/drizzle",

  // Entity definitions directory
  entitiesDir: projectConfig?.paths?.entities_dir ?? "entities",

  // Manifest output directory
  manifestDir: projectConfig?.paths?.manifest_dir ?? ".codegen",
};

/**
 * Layer paths within backend (relative to backendSrc)
 * Following Clean Architecture principles
 */
export const BACKEND_LAYERS = {
  // Domain layer - pure business logic, no framework deps
  domain: "domain",

  // Application layer - use cases, commands, queries
  application: "application",
  commands: "application/commands",
  queries: "application/queries",
  schemas: "application/schemas",

  // Infrastructure layer - external integrations
  infrastructure: "infrastructure",
  persistence: "infrastructure/persistence",
  drizzle: "infrastructure/persistence/drizzle",
  repositories: "infrastructure/persistence/repositories",

  // Presentation layer - REST controllers, GraphQL resolvers
  presentation: "presentation",
  controllers: "presentation/rest",

  // Modules - NestJS DI configuration (at src root, not inside infrastructure)
  modules: "modules",

  // Constants
  constants: "constants",
};

/**
 * Frontend paths (relative to frontendSrc)
 */
export const FRONTEND_LAYERS = {
  lib: "lib",
  collections: "lib/collections",
  store: "lib/store",
  entities: "lib/entities",
  generated: "generated",
  entityMetadata: "generated/entity-metadata",
};

/**
 * Shared package paths
 */
export const PACKAGE_PATHS = {
  db: "packages/db/src",
  dbEntities: "packages/db/src/entities",
};

/**
 * Get full path from project root
 */
export function getBackendPath(layer, subpath = "") {
  const basePath = `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS[layer]}`;
  return subpath ? `${basePath}/${subpath}` : basePath;
}

export function getFrontendPath(layer, subpath = "") {
  const basePath = `${BASE_PATHS.frontendSrc}/${FRONTEND_LAYERS[layer]}`;
  return subpath ? `${basePath}/${subpath}` : basePath;
}

/**
 * File naming conventions
 */
export const FILE_NAMING = {
  // File suffixes
  entity: ".entity.ts",
  repositoryInterface: ".repository.interface.ts",
  repository: ".repository.ts",
  command: ".command.ts",
  query: ".query.ts",
  dto: ".dto.ts",
  controller: ".controller.ts",
  module: ".module.ts",
  schema: ".schema.ts",
};

/**
 * Get dynamic paths based on entity configuration
 *
 * @param {Object} options
 * @param {string} options.name - Entity name (snake_case)
 * @param {string} options.plural - Plural form of entity name
 * @param {boolean} options.isNested - Whether to use nested folder structure
 * @param {boolean} options.isGrouped - Whether to group related files together
 * @returns {Object} Computed paths for this entity
 */
export function getEntityPaths({ name, plural, isNested = true, isGrouped = false }) {
  return {
    // Domain paths
    domain: isNested ? `${BACKEND_LAYERS.domain}/${name}` : BACKEND_LAYERS.domain,

    // Application paths
    commands: isNested
      ? `${BACKEND_LAYERS.commands}/${name}`
      : BACKEND_LAYERS.commands,
    queries: isNested
      ? `${BACKEND_LAYERS.queries}/${name}`
      : BACKEND_LAYERS.queries,

    // These are flat (single file per entity type)
    schemas: BACKEND_LAYERS.schemas,
    drizzle: BACKEND_LAYERS.drizzle,
    repositories: BACKEND_LAYERS.repositories,
    controllers: BACKEND_LAYERS.controllers,
    modules: BACKEND_LAYERS.modules,
  };
}

/**
 * Get file names based on entity configuration
 *
 * Layout options:
 * - isNested: controls folder nesting (domain/opportunity/ vs domain/)
 * - isGrouped: controls file grouping (index.ts vs separate files)
 *
 * @param {Object} options
 * @param {string} options.name - Entity name (snake_case)
 * @param {string} options.plural - Plural form of entity name
 * @param {boolean} options.isNested - Whether to use nested folder structure
 * @param {boolean} options.isGrouped - Whether to group related files together
 * @returns {Object} Computed file names for this entity
 */
export function getEntityFileNames({ name, plural, isNested = true, isGrouped = false }) {
  // Base file names (always computed for import path generation)
  const baseNames = {
    entity: `${name}${FILE_NAMING.entity}`,
    repositoryInterface: `${name}${FILE_NAMING.repositoryInterface}`,
    repository: `${name}${FILE_NAMING.repository}`,
    createCommand: isNested ? `create${FILE_NAMING.command}` : `create-${name}${FILE_NAMING.command}`,
    updateCommand: isNested ? `update${FILE_NAMING.command}` : `update-${name}${FILE_NAMING.command}`,
    deleteCommand: isNested ? `delete${FILE_NAMING.command}` : `delete-${name}${FILE_NAMING.command}`,
    getByIdQuery: isNested ? `get-by-id${FILE_NAMING.query}` : `get-${name}-by-id${FILE_NAMING.query}`,
    listQuery: isNested ? `list${FILE_NAMING.query}` : `list-${plural}${FILE_NAMING.query}`,
    dto: `${name}${FILE_NAMING.dto}`,
    controller: `${plural}${FILE_NAMING.controller}`,
    module: `${plural}${FILE_NAMING.module}`,
    schema: `${name}${FILE_NAMING.schema}`,
  };

  // When grouped, add index file names for combined output
  if (isGrouped) {
    return {
      ...baseNames,
      // Grouped output files (used by grouped-index.ejs.t templates)
      domainIndex: "index.ts",   // Contains entity + repository interface
      commandsIndex: "index.ts", // Contains all commands
      queriesIndex: "index.ts",  // Contains all queries
      // Flag for templates
      isGrouped: true,
    };
  }

  // Separate mode - just the base names
  return {
    ...baseNames,
    isGrouped: false,
  };
}

/**
 * Get layout configuration from entity definition
 *
 * @param {Object} entity - Entity definition from YAML
 * @returns {Object} Layout configuration
 */
export function getLayoutConfig(entity) {
  const folderStructure = entity.folder_structure || DEFAULT_LAYOUT.folderStructure;
  const fileGrouping = entity.file_grouping || DEFAULT_LAYOUT.fileGrouping;

  return {
    folderStructure,
    fileGrouping,
    isNested: folderStructure === FOLDER_STRUCTURES.nested,
    isGrouped: fileGrouping === FILE_GROUPINGS.grouped,
  };
}

/**
 * Import path helpers
 * Calculate relative import paths from one location to another
 */
export function getImportPaths({ isNested }) {
  return {
    // From commands/queries to other locations
    constants: isNested ? "../../../constants" : "../../constants",
    domain: isNested ? "../../../domain" : "../../domain",
    schemas: isNested ? "../../schemas" : "../schemas",

    // From domain to other domain files
    domainEntity: (name) => `./${name}.entity`,

    // From module to commands/queries
    moduleToQuery: (name, queryFile) =>
      isNested
        ? `../application/queries/${name}/${queryFile}`
        : `../application/queries/${queryFile}`,
    moduleToCommand: (name, commandFile) =>
      isNested
        ? `../application/commands/${name}/${commandFile}`
        : `../application/commands/${commandFile}`,

    // From controller to commands/queries
    controllerToQuery: (name, queryFile) =>
      isNested
        ? `../../application/queries/${name}/${queryFile}`
        : `../../application/queries/${queryFile}`,
    controllerToCommand: (name, commandFile) =>
      isNested
        ? `../../application/commands/${name}/${commandFile}`
        : `../../application/commands/${commandFile}`,
  };
}

/**
 * Test configuration - paths for test runner
 */
export const TEST_OUTPUT_PATHS = [
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.domain}`,
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.application}`,
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.drizzle}`,
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.repositories}`,
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.modules}`,
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.controllers}`,
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.constants}/tokens.ts`,
  `${BASE_PATHS.backendSrc}/app.module.ts`,
  `${BASE_PATHS.frontendSrc}/${FRONTEND_LAYERS.collections}`,
  `${BASE_PATHS.frontendSrc}/${FRONTEND_LAYERS.store}`,
  `${BASE_PATHS.frontendSrc}/${FRONTEND_LAYERS.entityMetadata}`,
  PACKAGE_PATHS.dbEntities,
];

export const INJECTABLE_FILES = [
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.domain}/index.ts`,
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.schemas}/index.ts`,
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.drizzle}/index.ts`,
  `${BASE_PATHS.backendSrc}/${BACKEND_LAYERS.constants}/tokens.ts`,
  `${BASE_PATHS.backendSrc}/app.module.ts`,
  `${BASE_PATHS.frontendSrc}/${FRONTEND_LAYERS.collections}/index.ts`,
  `${BASE_PATHS.frontendSrc}/${FRONTEND_LAYERS.store}/index.ts`,
  `${PACKAGE_PATHS.dbEntities}/index.ts`,
];

// ============================================================================
// Database Configuration
// ============================================================================

/**
 * Database configuration
 * Default to postgres for backward compatibility
 */
export const DATABASE_CONFIG = {
  dialect: projectConfig?.database?.dialect ?? 'postgres',
};

/**
 * Get database dialect from config
 */
export function getDatabaseDialect() {
  return DATABASE_CONFIG.dialect;
}

/**
 * Get project configuration (useful for template access)
 */
export function getProjectConfig() {
  return projectConfig;
}

// Default export for convenience
export default {
  // Layout options
  FOLDER_STRUCTURES,
  FILE_GROUPINGS,
  DEFAULT_LAYOUT,
  // Path configuration
  BASE_PATHS,
  BACKEND_LAYERS,
  FRONTEND_LAYERS,
  PACKAGE_PATHS,
  FILE_NAMING,
  TEST_OUTPUT_PATHS,
  INJECTABLE_FILES,
  // Database configuration
  DATABASE_CONFIG,
  // Helper functions
  getBackendPath,
  getFrontendPath,
  getEntityPaths,
  getEntityFileNames,
  getImportPaths,
  getLayoutConfig,
  getDatabaseDialect,
  getProjectConfig,
};
