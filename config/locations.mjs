/**
 * Centralized location configuration for codegen
 *
 * Each location defines both:
 *   - path: where files are written (filesystem path from project root)
 *   - import: how to import from that location (TypeScript import alias)
 *
 * This ensures a single source of truth for all path references.
 *
 * Usage in templates:
 *   to: <%= locations.dbEntities.path %>/<%= name %>.ts
 *   import { schema } from '<%= locations.dbEntities.import %>/<%= name %>';
 */

import { projectConfig } from './config-loader.mjs';

// ============================================================================
// Default Locations
// ============================================================================

/**
 * Default location definitions
 * Each location has a `path` (filesystem) and `import` (TypeScript alias)
 *
 * These can be overridden in codegen.config.yaml under the `locations:` key
 */
const DEFAULT_LOCATIONS = {
  // ===========================================================================
  // Shared packages (consumed by both frontend and backend)
  // ===========================================================================

  /** Shared Zod entity schemas */
  dbEntities: {
    path: 'packages/db/src/entities',
    import: '@repo/db/entities',
  },

  /** Context engine (polymorphic relationships, facts) */
  dbContextEngine: {
    path: 'packages/db/src/context-engine',
    import: '@repo/db/context-engine',
  },

  /** tRPC client */
  trpcClient: {
    path: 'packages/trpc/src/client',
    import: '@repo/trpc/client',
  },

  // ===========================================================================
  // Frontend locations
  // ===========================================================================

  /** Frontend source root */
  frontendSrc: {
    path: 'apps/frontend/src',
    import: '@',
  },

  /** Electric SQL collections */
  frontendCollections: {
    path: 'apps/frontend/src/lib/collections',
    import: '@/lib/collections',
  },

  /** Frontend store (TanStack DB) */
  frontendStore: {
    path: 'apps/frontend/src/lib/store',
    import: '@/lib/store',
  },

  /** Per-entity store hooks */
  frontendStoreEntities: {
    path: 'apps/frontend/src/lib/store/entities',
    import: '@/lib/store/entities',
  },

  /** Unified entity definitions */
  frontendEntities: {
    path: 'apps/frontend/src/lib/entities',
    import: '@/lib/entities',
  },

  /** Generated entity files (metadata, collections, types) */
  frontendGenerated: {
    path: 'apps/frontend/src/generated',
    import: '@/generated',
  },

  /** Entity metadata generated files */
  frontendEntityMetadata: {
    path: 'apps/frontend/src/generated/entity-metadata',
    import: '@/generated/entity-metadata',
  },

  /** Field meta type definitions */
  frontendFieldMetaTypes: {
    path: 'apps/frontend/src/lib/types',
    import: '@/lib/types',
  },

  /** Auth helpers (for collections) */
  frontendCollectionsAuth: {
    path: 'apps/frontend/src/lib/collections/auth',
    import: '@/lib/collections/auth',
  },

  // ===========================================================================
  // Backend locations
  // ===========================================================================

  /** Backend source root */
  backendSrc: {
    path: 'app/backend/src',
    import: '@backend',
  },

  /** Domain layer */
  backendDomain: {
    path: 'app/backend/src/domain',
    import: '@backend/domain',
  },

  /** Application layer - commands */
  backendCommands: {
    path: 'app/backend/src/application/commands',
    import: '@backend/application/commands',
  },

  /** Application layer - queries */
  backendQueries: {
    path: 'app/backend/src/application/queries',
    import: '@backend/application/queries',
  },

  /** Application layer - schemas/DTOs */
  backendSchemas: {
    path: 'app/backend/src/application/schemas',
    import: '@backend/application/schemas',
  },

  /** Infrastructure - Drizzle schemas */
  backendDrizzle: {
    path: 'app/backend/src/infrastructure/persistence/drizzle',
    import: '@backend/infrastructure/persistence/drizzle',
  },

  /** Infrastructure - Repositories */
  backendRepositories: {
    path: 'app/backend/src/infrastructure/persistence/repositories',
    import: '@backend/infrastructure/persistence/repositories',
  },

  /** Presentation - REST controllers */
  backendControllers: {
    path: 'app/backend/src/presentation/rest',
    import: '@backend/presentation/rest',
  },

  /** NestJS modules */
  backendModules: {
    path: 'app/backend/src/modules',
    import: '@backend/modules',
  },

  /** Constants (tokens, etc) */
  backendConstants: {
    path: 'app/backend/src/constants',
    import: '@backend/constants',
  },
};

// ============================================================================
// Merge with project config
// ============================================================================

/**
 * Merge default locations with project-specific overrides
 */
function buildLocations(projectConfig) {
  const overrides = projectConfig?.locations || {};
  const locations = { ...DEFAULT_LOCATIONS };

  // Deep merge each location
  for (const [key, override] of Object.entries(overrides)) {
    if (locations[key]) {
      // Merge with existing defaults
      locations[key] = {
        ...locations[key],
        ...override,
      };
    } else {
      // New location defined in config
      locations[key] = override;
    }
  }

  return locations;
}

export const LOCATIONS = buildLocations(projectConfig);

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Get a location by key, with optional subpath
 * @param {string} key - Location key (e.g., 'dbEntities')
 * @param {string} [subpath] - Optional subpath to append
 * @returns {{ path: string, import: string }}
 */
export function getLocation(key, subpath = '') {
  const location = LOCATIONS[key];
  if (!location) {
    throw new Error(`Unknown location: ${key}`);
  }

  if (!subpath) {
    return location;
  }

  return {
    path: `${location.path}/${subpath}`,
    import: `${location.import}/${subpath}`,
  };
}

/**
 * Get just the filesystem path for a location
 */
export function getLocationPath(key, subpath = '') {
  return getLocation(key, subpath).path;
}

/**
 * Get just the import alias for a location
 */
export function getLocationImport(key, subpath = '') {
  return getLocation(key, subpath).import;
}

export default {
  LOCATIONS,
  getLocation,
  getLocationPath,
  getLocationImport,
};
