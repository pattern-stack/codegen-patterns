/**
 * Centralized path configuration for codegen
 *
 * All generated file paths are defined here to make it easy to update
 * the architecture structure without hunting through multiple files.
 *
 * NEW: For path + import alias pairs, see ./locations.mjs
 * The LOCATIONS export provides both filesystem paths and TypeScript import aliases.
 *
 * NEW: For configurable naming conventions, see ./naming-config.mjs
 * The naming config supports fileCase, suffixStyle, entityInclusion, and terminology options.
 *
 * Usage:
 *   import { paths, getPath, LOCATIONS } from '../config/paths.js';
 */

import { projectConfig } from './config-loader.mjs';
import { getNamingConfig } from './naming-config.mjs';
import { applyCase, toPascalCase, getCaseSeparator } from './case-converters.mjs';
import { FILE_TYPE_SUFFIXES } from '../schema/naming-config.schema.ts';

// Re-export LOCATIONS for unified path + import configuration
export { LOCATIONS, getLocation, getLocationPath, getLocationImport } from './locations.mjs';

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
 * File naming conventions (legacy constant for backward compatibility)
 *
 * @deprecated Use computeFileNaming() or computeFileName() for config-driven naming
 */
export const FILE_NAMING = {
  // File suffixes (dotted style - default)
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

// ============================================================================
// Config-Driven File Naming
// ============================================================================

/**
 * Compute file suffix based on file type and suffix style
 *
 * @param {string} fileType - File type from FILE_TYPE_SUFFIXES
 * @param {'dotted' | 'suffixed' | 'worded'} suffixStyle - How to apply suffix
 * @param {'kebab-case' | 'snake_case' | 'camelCase' | 'PascalCase'} fileCase - For worded style separator
 * @returns {string} Suffix without .ts extension (e.g., ".entity" or "Entity" or "-entity")
 */
function computeSuffix(fileType, suffixStyle, fileCase) {
  const suffixInfo = FILE_TYPE_SUFFIXES[fileType];
  if (!suffixInfo) {
    console.warn(`Unknown file type: ${fileType}, using .${fileType}`);
    return `.${fileType}`;
  }

  switch (suffixStyle) {
    case 'dotted':
      return suffixInfo.dotted;
    case 'suffixed':
      return suffixInfo.suffixed;
    case 'worded':
      // Use the case-appropriate separator
      const separator = getCaseSeparator(fileCase);
      if (separator) {
        return `${separator}${suffixInfo.word}`;
      }
      // For camelCase/PascalCase, capitalize the suffix word
      return toPascalCase(suffixInfo.word);
    default:
      return suffixInfo.dotted;
  }
}

/**
 * Compute a single file name from entity name, type, and config
 *
 * @param {string} entityName - Entity name (typically snake_case from YAML)
 * @param {string} fileType - File type key (entity, repository, command, etc.)
 * @param {Object} namingConfig - Naming configuration
 * @param {Object} options - Additional options
 * @param {boolean} options.isNested - Whether using nested folder structure
 * @param {string} options.plural - Plural form of entity name
 * @param {string} options.action - Action prefix for commands/queries (create, update, delete, etc.)
 * @returns {string} Complete file name with .ts extension
 */
export function computeFileName(entityName, fileType, namingConfig = null, options = {}) {
  const config = namingConfig || getNamingConfig();
  const { fileCase, suffixStyle, entityInclusion, terminology } = config;
  const { isNested = true, plural, action } = options;

  // Determine the base name
  let baseName = entityName;

  // Compute the suffix based on style and terminology
  // For commands/queries with use-case terminology, override the default suffix
  const useUseCaseSuffix =
    (fileType === 'command' && terminology.command === 'use-case') ||
    (fileType === 'query' && terminology.query === 'use-case');

  let suffix;
  if (useUseCaseSuffix) {
    // Use-case terminology: generate .use-case / UseCase / -use-case suffix
    const separator = getCaseSeparator(fileCase);
    suffix = suffixStyle === 'dotted' ? '.use-case' :
             suffixStyle === 'suffixed' ? 'UseCase' :
             separator ? `${separator}use-case` : 'UseCase';
  } else {
    suffix = computeSuffix(fileType, suffixStyle, fileCase);
  }

  // For command/query files with action prefix
  if (action) {
    // Determine if entity name should be included
    const includeEntity =
      entityInclusion === 'always' ||
      (entityInclusion === 'flat-only' && !isNested);

    if (includeEntity) {
      // Use natural action patterns (Dealbrain-style):
      // - get-{entity}-by-id (not get-by-id-{entity})
      // - get-all-{plural} (not list-{plural})
      // - {action}-{entity} for others (create-user, update-user, delete-user)
      if (action === 'get-by-id') {
        baseName = `get-${entityName}-by-id`;
      } else if (action === 'list' && plural) {
        baseName = `get-all-${plural}`;
      } else {
        baseName = `${action}-${entityName}`;
      }
    } else {
      // Exclude entity: create.command.ts
      baseName = action;
    }
  }

  // For controller/module, use plural form
  if ((fileType === 'controller' || fileType === 'module') && plural) {
    baseName = plural;
  }

  // Apply case transformation to base name
  const casedName = applyCase(baseName, fileCase);

  // Build final file name
  if (suffixStyle === 'suffixed') {
    // For suffixed style, base should also be PascalCase
    const pascalBase = toPascalCase(baseName);
    return `${pascalBase}${suffix}.ts`;
  }

  return `${casedName}${suffix}.ts`;
}

/**
 * Compute FILE_NAMING map from configuration
 *
 * Returns same shape as legacy FILE_NAMING constant but computed from config.
 * Useful for backward compatibility with existing code.
 *
 * @param {Object} namingConfig - Optional naming configuration (uses default if not provided)
 * @returns {Object} FILE_NAMING-compatible object
 */
export function computeFileNaming(namingConfig = null) {
  const config = namingConfig || getNamingConfig();
  const { suffixStyle, fileCase } = config;

  const result = {};
  const fileTypes = ['entity', 'repositoryInterface', 'repository', 'command', 'query', 'dto', 'controller', 'module', 'schema'];

  for (const type of fileTypes) {
    const suffix = computeSuffix(type, suffixStyle, fileCase);
    result[type] = `${suffix}.ts`;
  }

  return result;
}

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
 * - namingConfig: optional naming configuration (uses default if not provided)
 *
 * @param {Object} options
 * @param {string} options.name - Entity name (snake_case)
 * @param {string} options.plural - Plural form of entity name
 * @param {boolean} options.isNested - Whether to use nested folder structure
 * @param {boolean} options.isGrouped - Whether to group related files together
 * @param {Object} options.namingConfig - Optional naming configuration
 * @returns {Object} Computed file names for this entity
 */
export function getEntityFileNames({ name, plural, isNested = true, isGrouped = false, namingConfig = null }) {
  // Use config-driven naming if available, otherwise use legacy hardcoded values
  const config = namingConfig || getNamingConfig();
  const opts = { isNested, plural };

  // Base file names (always computed for import path generation)
  const baseNames = {
    entity: computeFileName(name, 'entity', config, opts),
    repositoryInterface: computeFileName(name, 'repositoryInterface', config, opts),
    repository: computeFileName(name, 'repository', config, opts),
    createCommand: computeFileName(name, 'command', config, { ...opts, action: 'create' }),
    updateCommand: computeFileName(name, 'command', config, { ...opts, action: 'update' }),
    deleteCommand: computeFileName(name, 'command', config, { ...opts, action: 'delete' }),
    getByIdQuery: computeFileName(name, 'query', config, { ...opts, action: 'get-by-id' }),
    listQuery: computeFileName(plural, 'query', config, { ...opts, action: 'list' }),
    dto: computeFileName(name, 'dto', config, opts),
    controller: computeFileName(name, 'controller', config, { ...opts, plural }),
    module: computeFileName(name, 'module', config, { ...opts, plural }),
    schema: computeFileName(name, 'schema', config, opts),
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

// Import LOCATIONS for default export
import { LOCATIONS } from './locations.mjs';

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
  // NEW: Unified locations (path + import)
  LOCATIONS,
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
  // NEW: Config-driven naming functions
  computeFileName,
  computeFileNaming,
};
