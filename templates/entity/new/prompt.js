/**
 * Hygen prompt.js - Loads entity YAML and prepares template locals
 *
 * Usage: bunx hygen entity new --yaml entities/opportunity.yaml
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import pluralizePkg from "pluralize";
import {
  BACKEND_LAYERS,
  BASE_PATHS,
  FOLDER_STRUCTURES,
  FILE_GROUPINGS,
  LOCATIONS,
  getEntityPaths,
  getEntityFileNames,
  getImportPaths,
  getLayoutConfig,
  getDatabaseDialect,
  getProjectConfig,
  getGenerateConfig,
} from "../../../src/config/paths.mjs";
import { getNamingConfig } from "../../../src/config/naming-config.mjs";
import { renderGeneratedBanner } from "../../_shared/generated-banner.mjs";
import {
  loadRuntimeMode,
  subsystemsImport,
  runtimeImport,
  rewriteSharedImport,
} from "../../../src/config/runtime-mode.mjs";

// ============================================================================
// Behavior Registry (inline to avoid import issues with Hygen)
// ============================================================================

const behaviorRegistry = {
  timestamps: {
    name: "timestamps",
    fields: [
      {
        name: "created_at",
        camelName: "createdAt",
        type: "datetime",
        tsType: "Date",
        drizzleType: "timestamp",
        zodType: "z.coerce.date()",
        nullable: false,
      },
      {
        name: "updated_at",
        camelName: "updatedAt",
        type: "datetime",
        tsType: "Date",
        drizzleType: "timestamp",
        zodType: "z.coerce.date()",
        nullable: false,
      },
    ],
    drizzleImports: ["timestamp"],
    configKey: "timestamps",
  },
  soft_delete: {
    name: "soft_delete",
    fields: [
      {
        name: "deleted_at",
        camelName: "deletedAt",
        type: "datetime",
        tsType: "Date | null",
        drizzleType: "timestamp",
        zodType: "z.coerce.date().nullable()",
        nullable: true,
      },
    ],
    drizzleImports: ["timestamp"],
    configKey: "softDelete",
  },
  user_tracking: {
    name: "user_tracking",
    fields: [
      {
        name: "created_by",
        camelName: "createdBy",
        type: "uuid",
        tsType: "string | null",
        drizzleType: "uuid",
        zodType: "z.string().uuid().nullable()",
        nullable: true,
        foreignKey: "users.id",
      },
      {
        name: "updated_by",
        camelName: "updatedBy",
        type: "uuid",
        tsType: "string | null",
        drizzleType: "uuid",
        zodType: "z.string().uuid().nullable()",
        nullable: true,
        foreignKey: "users.id",
      },
    ],
    drizzleImports: ["uuid"],
    configKey: "userTracking",
  },
  temporal_validity: {
    name: "temporal_validity",
    fields: [
      {
        name: "valid_from",
        camelName: "validFrom",
        type: "datetime",
        tsType: "Date | null",
        drizzleType: "timestamp",
        zodType: "z.coerce.date().nullable()",
        nullable: true,
      },
      {
        name: "valid_to",
        camelName: "validTo",
        type: "datetime",
        tsType: "Date | null",
        drizzleType: "timestamp",
        zodType: "z.coerce.date().nullable()",
        nullable: true,
      },
      {
        name: "is_active",
        camelName: "isActive",
        type: "boolean",
        tsType: "boolean",
        drizzleType: "boolean",
        zodType: "z.boolean()",
        nullable: false,
        default: true,
      },
    ],
    drizzleImports: ["timestamp", "boolean"],
    configKey: "temporalValidity",
  },
};

/**
 * Load codegen config from codegen.config.yaml
 */
function loadCodegenConfig(cwd) {
  const configPath = path.resolve(cwd, "codegen.config.yaml");
  const defaultConfig = { behaviors: { strategy: "inline" } };

  if (!fs.existsSync(configPath)) {
    return defaultConfig;
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(content);

    return {
      behaviors: {
        strategy: parsed?.behaviors?.strategy || "inline",
      },
    };
  } catch {
    return defaultConfig;
  }
}

/**
 * Normalize behavior config (string or object with name/options)
 */
function normalizeBehaviorConfig(config) {
  if (typeof config === "string") {
    return { name: config, options: {} };
  }
  return { name: config.name, options: config.options || {} };
}

/**
 * Resolve behaviors from entity YAML
 */
function resolveBehaviors(behaviorConfigs) {
  const configs = (behaviorConfigs || []).map(normalizeBehaviorConfig);
  const fields = [];
  const drizzleImports = new Set();
  const addedFieldNames = new Set();

  const enabledNames = new Set(configs.map((c) => c.name));

  for (const config of configs) {
    const behavior = behaviorRegistry[config.name];
    if (!behavior) continue;

    for (const field of behavior.fields) {
      if (!addedFieldNames.has(field.name)) {
        fields.push(field);
        addedFieldNames.add(field.name);
      }
    }

    for (const imp of behavior.drizzleImports) {
      drizzleImports.add(imp);
    }
  }

  const hasTimestamps = enabledNames.has("timestamps");
  const hasSoftDelete = enabledNames.has("soft_delete");
  const hasUserTracking = enabledNames.has("user_tracking");
  const hasTemporalValidity = enabledNames.has("temporal_validity");

  return {
    configs,
    fields,
    drizzleImports: Array.from(drizzleImports).sort(),
    repositoryConfig: {
      timestamps: hasTimestamps,
      softDelete: hasSoftDelete,
      userTracking: hasUserTracking,
      temporalValidity: hasTemporalValidity,
      versionable: false,
    },
    hasBehaviors: configs.length > 0,
    hasTimestamps,
    hasSoftDelete,
    hasUserTracking,
    hasTemporalValidity,
  };
}


// ============================================================================
// Patterns — subprocess-local registry load (PATTERN-5)
// ============================================================================
//
// The Hygen subprocess has no shared memory with the CLI process, so the
// pattern registry is rebuilt here from scratch. Library patterns register
// themselves as a side effect of importing the barrel; app-defined patterns
// are loaded from `codegen.config.yaml patterns:` globs (default
// `src/patterns/*.pattern.ts`). Both loads are deterministic and
// side-effect-free — the registry determinism test in
// `src/__tests__/patterns/registry.test.ts` pins down that the CLI and the
// subprocess produce identical sorted results for the same file set.

let _patternsLoadPromise = null;

async function ensurePatternsRegistryLoaded() {
  if (!_patternsLoadPromise) {
    _patternsLoadPromise = (async () => {
      // Side-effect import: pre-registers the five library patterns.
      await import('../../../src/patterns/library/index.js');
      const { loadAppPatterns } = await import('../../../src/patterns/registry.js');

      // Read the `patterns:` manifest from codegen.config.yaml. Defaults
      // to a single sensible glob when the key is absent — matches the
      // ADR-031 default discovery shape.
      const configPath = path.resolve(process.cwd(), 'codegen.config.yaml');
      let manifest = ['src/patterns/*.pattern.ts'];
      if (fs.existsSync(configPath)) {
        try {
          const parsed = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
          if (Array.isArray(parsed?.patterns)) {
            manifest = parsed.patterns;
          }
        } catch {
          // fall through with the default manifest; a malformed
          // codegen.config.yaml is already surfaced by the CLI's config
          // loader elsewhere.
        }
      }
      const result = await loadAppPatterns(manifest, process.cwd());
      for (const err of result.errors) {
        // eslint-disable-next-line no-console
        console.warn(`[codegen] ${err}`);
      }
    })();
  }
  return _patternsLoadPromise;
}

export default {
  prompt: async ({ args }) => {
    const yamlPath = args.yaml;
    if (!yamlPath) {
      throw new Error(
        "Missing --yaml argument. Usage: bunx hygen entity new --yaml entities/opportunity.yaml",
      );
    }

    // Load and parse YAML
    const fullPath = path.resolve(process.cwd(), yamlPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const definition = yaml.parse(content);

    // Load global codegen config
    const codegenConfig = loadCodegenConfig(process.cwd());

    // Resolve the runtime mode (ADR-037) once — drives every runtime import
    // specifier the generated entity code carries.
    const runtimeMode = loadRuntimeMode(process.cwd());

    // Prepare locals for templates
    const entity = definition.entity;
    const fields = definition.fields || {};
    const relationships = definition.relationships || {};
    const behaviors = definition.behaviors || [];

    // v2 blocks (optional — absent in v1 entities)
    const queriesBlock = definition.queries || null;
    const integrationBlock = definition.integration || null;
    const eventsBlock = definition.events || null;
    // EVT-7: emits is semantically 3-valued — undefined (fallback path),
    // [] (explicit opt-out), or string[] (typed emission). Preserve the
    // undefined/null-vs-empty distinction by refusing the || null shortcut.
    const emitsBlock = Array.isArray(definition.emits)
      ? definition.emits
      : null;

    // Helper functions
    const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const camelCase = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const pascalCase = (s) => capitalize(camelCase(s));
    const pluralize = (s) => pluralizePkg.plural(s);

    // ============================================================================
    // UI Metadata Inference Functions
    // ============================================================================

    /**
     * Format field name as human-readable label
     * e.g., "created_at" -> "Created At", "account_id" -> "Account Id"
     */
    const formatLabel = (fieldName) => {
      return fieldName
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    };

    /**
     * Infer UI type from field definition
     * Considers explicit ui_type, field type, choices, foreign keys, and name patterns
     */
    const inferUiType = (fieldName, field) => {
      // If explicit ui_type provided, use it
      if (field.ui_type) return field.ui_type;

      // Check for choices (enum)
      if (Array.isArray(field.choices) && field.choices.length > 0)
        return "enum";

      // Check for foreign key (reference)
      if (field.foreign_key) return "reference";

      // Check field name patterns
      const nameLower = fieldName.toLowerCase();
      if (nameLower.includes("email")) return "email";
      if (nameLower.includes("url") || nameLower.includes("website"))
        return "url";
      if (nameLower.includes("password")) return "password";
      if (
        nameLower.includes("price") ||
        nameLower.includes("amount") ||
        nameLower.includes("cost") ||
        nameLower.includes("value") ||
        nameLower.includes("revenue")
      )
        return "money";
      if (nameLower.includes("percent") || nameLower.includes("rate"))
        return "percentage";

      // Infer from field type
      const typeMap = {
        string:
          field.max_length && field.max_length > 500 ? "textarea" : "text",
        integer: "number",
        decimal: "number",
        boolean: "boolean",
        uuid: "text",
        date: "date",
        datetime: "datetime",
        json: "json",
      };

      return typeMap[field.type] || "text";
    };

    /**
     * Infer UI group from field name patterns
     */
    const inferUiGroup = (fieldName, field) => {
      if (field.ui_group) return field.ui_group;

      const nameLower = fieldName.toLowerCase();

      // Common field groupings
      if (["id", "uuid"].includes(nameLower)) return "identification";
      if (["created_at", "updated_at", "deleted_at"].includes(nameLower))
        return "metadata";
      if (
        nameLower.includes("price") ||
        nameLower.includes("amount") ||
        nameLower.includes("cost") ||
        nameLower.includes("value") ||
        nameLower.includes("revenue")
      )
        return "financial";
      if (nameLower.includes("email") || nameLower.includes("phone"))
        return "contact";
      if (nameLower.includes("name") || nameLower.includes("title"))
        return "identification";
      if (nameLower.includes("description") || nameLower.includes("notes"))
        return "content";
      if (
        nameLower.includes("status") ||
        nameLower.includes("state") ||
        nameLower.includes("stage")
      )
        return "status";
      if (field.foreign_key) return "relationships";

      return "general";
    };

    /**
     * Infer UI importance from field properties
     */
    const inferUiImportance = (fieldName, field) => {
      if (field.ui_importance) return field.ui_importance;

      const nameLower = fieldName.toLowerCase();

      // Auto-generated fields are tertiary
      if (["id", "created_at", "updated_at", "deleted_at"].includes(nameLower))
        return "tertiary";

      // Foreign keys that are likely internal references
      if (field.foreign_key && nameLower.endsWith("_id")) return "secondary";

      // Required fields are primary by default
      if (field.required) return "primary";

      // Name/title fields are typically primary
      if (nameLower.includes("name") || nameLower.includes("title"))
        return "primary";

      return "secondary";
    };

    // Entity name variations
    const name = entity.name; // opportunity
    const plural = entity.plural; // opportunities
    const table = entity.table; // opportunities
    const className = pascalCase(name); // Opportunity
    const classNamePlural = pascalCase(plural); // Opportunities
    const camelName = camelCase(name); // opportunity
    const repositoryToken = `${pascalCase(name).toUpperCase()}_REPOSITORY`; // OPPORTUNITY_REPOSITORY

    // Layout configuration (folder structure + file grouping)
    // See tools/codegen/config/paths.js for options
    const layout = getLayoutConfig(entity);
    const { folderStructure, fileGrouping, isNested, isGrouped } = layout;

    // Behavior strategy (base_class vs inline)
    // Per-entity override takes precedence over global config
    const behaviorStrategy =
      entity.behavior_strategy || codegenConfig.behaviors.strategy;

    // Resolve behaviors
    const resolvedBehaviors = resolveBehaviors(behaviors);

    // Compute paths using centralized config
    // See tools/codegen/config/paths.js for path definitions
    const paths = getEntityPaths({ name, plural, isNested, isGrouped });

    // Load naming configuration for file naming
    const namingConfig = getNamingConfig();

    // File names using centralized config with naming configuration
    const fileNames = getEntityFileNames({ name, plural, isNested, isGrouped, namingConfig });

    // Terminology-aware class name suffixes
    // Supports 'command' vs 'use-case' naming for application layer
    const applicationLayerSuffix = namingConfig.terminology.command === 'use-case' ? 'UseCase' : 'Command';
    const queryLayerSuffix = namingConfig.terminology.query === 'use-case' ? 'UseCase' : 'Query';

    // Pre-computed class names using configured terminology
    const createCommandClass = `Create${className}${applicationLayerSuffix}`;
    const updateCommandClass = `Update${className}${applicationLayerSuffix}`;
    const deleteCommandClass = `Delete${className}${applicationLayerSuffix}`;
    const getByIdQueryClass = `Get${className}ById${queryLayerSuffix}`;
    const listQueryClass = `List${classNamePlural}${queryLayerSuffix}`;

    // Step 1: Compute all possible output paths
    const src = BASE_PATHS.backendSrc;
    const allPaths = {
      // Domain layer
      entity: `${src}/${paths.domain}/${fileNames.entity}`,
      repositoryInterface: `${src}/${paths.domain}/${fileNames.repositoryInterface}`,
      domainGroupedIndex: `${src}/${paths.domain}/index.ts`,

      // Application layer - commands
      createCommand: `${src}/${paths.commands}/${fileNames.createCommand}`,
      updateCommand: `${src}/${paths.commands}/${fileNames.updateCommand}`,
      deleteCommand: `${src}/${paths.commands}/${fileNames.deleteCommand}`,
      commandsIndex: `${src}/${paths.commands}/index.ts`,

      // Application layer - queries
      getByIdQuery: `${src}/${paths.queries}/${fileNames.getByIdQuery}`,
      listQuery: `${src}/${paths.queries}/${fileNames.listQuery}`,
      queriesIndex: `${src}/${paths.queries}/index.ts`,

      // Application layer - schemas (always generated)
      dto: `${src}/${paths.schemas}/${fileNames.dto}`,

      // Infrastructure layer (always generated)
      drizzleSchema: `${src}/${paths.drizzle}/${fileNames.schema}`,
      repository: `${src}/${paths.repositories}/${fileNames.repository}`,

      // Presentation layer (always generated)
      controller: `${src}/${paths.controllers}/${fileNames.controller}`,

      // Modules (always generated)
      module: `${src}/${paths.modules}/${fileNames.module}`,
    };

    // Step 2: Apply mode filter (null = skip generation)
    const outputPaths = {
      // Domain: separate files OR grouped index
      entity: !isGrouped ? allPaths.entity : null,
      repositoryInterface: !isGrouped ? allPaths.repositoryInterface : null,
      domainGroupedIndex: isGrouped ? allPaths.domainGroupedIndex : null,

      // Commands: separate files OR grouped index
      createCommand: !isGrouped ? allPaths.createCommand : null,
      updateCommand: !isGrouped ? allPaths.updateCommand : null,
      deleteCommand: !isGrouped ? allPaths.deleteCommand : null,
      commandsIndex: (!isGrouped && isNested) ? allPaths.commandsIndex : null,
      commandsGroupedIndex: isGrouped ? allPaths.commandsIndex : null,

      // Queries: separate files OR grouped index
      getByIdQuery: !isGrouped ? allPaths.getByIdQuery : null,
      listQuery: !isGrouped ? allPaths.listQuery : null,
      queriesIndex: (!isGrouped && isNested) ? allPaths.queriesIndex : null,
      queriesGroupedIndex: isGrouped ? allPaths.queriesIndex : null,

      // Always generated (mode-independent)
      dto: allPaths.dto,
      drizzleSchema: allPaths.drizzleSchema,
      repository: allPaths.repository,
      controller: allPaths.controller,
      module: allPaths.module,
    };

    // Import paths using centralized config
    // See tools/codegen/config/paths.js for path definitions
    const importHelpers = getImportPaths({ isNested });
    const imports = {
      // From commands/queries to other locations
      constants: importHelpers.constants(name),
      domain: importHelpers.domain(name),
      schemas: importHelpers.schemas(name),
      // From domain to other domain files (same folder when nested)
      domainEntity: importHelpers.domainEntity(name),
      // From module (modules/) to commands/queries
      moduleToGetByIdQuery: importHelpers.moduleToQuery(name, fileNames.getByIdQuery.replace('.ts', '')),
      moduleToListQuery: importHelpers.moduleToQuery(name, fileNames.listQuery.replace('.ts', '')),
      moduleToDeclarativeQueries: importHelpers.moduleToQuery(name, 'declarative-queries'),
      moduleToRelationshipQueries: importHelpers.moduleToQuery(name, 'relationships.queries'),
      moduleToCreateCommand: importHelpers.moduleToCommand(name, fileNames.createCommand.replace('.ts', '')),
      moduleToUpdateCommand: importHelpers.moduleToCommand(name, fileNames.updateCommand.replace('.ts', '')),
      moduleToDeleteCommand: importHelpers.moduleToCommand(name, fileNames.deleteCommand.replace('.ts', '')),
      moduleToRepository: importHelpers.moduleToRepository(fileNames.repository.replace('.ts', '')),
      moduleToConstants: importHelpers.moduleToConstants(),
      moduleToDatabaseModule: importHelpers.moduleToDatabaseModule(),
      moduleToController: importHelpers.moduleToController(fileNames.controller.replace('.ts', '')),
      // OPENAPI-2: module imports DTO file to register Zod schemas at onModuleInit.
      moduleToDto: importHelpers.moduleToDto(fileNames.dto.replace('.ts', '')),
      // ADR-033.1: integration-source module imports the entity type from the
      // domain barrel for the IChangeSource<T> type parameter.
      moduleToDomain: importHelpers.moduleToDomain(),
      // From controller (presentation/rest/) to queries/commands
      controllerToGetByIdQuery: importHelpers.controllerToQuery(name, fileNames.getByIdQuery.replace('.ts', '')),
      controllerToListQuery: importHelpers.controllerToQuery(name, fileNames.listQuery.replace('.ts', '')),
      controllerToCreateCommand: importHelpers.controllerToCommand(name, fileNames.createCommand.replace('.ts', '')),
      controllerToUpdateCommand: importHelpers.controllerToCommand(name, fileNames.updateCommand.replace('.ts', '')),
      controllerToDeleteCommand: importHelpers.controllerToCommand(name, fileNames.deleteCommand.replace('.ts', '')),
      controllerToSchemas: importHelpers.controllerToSchemas(),
      controllerToDomain: importHelpers.controllerToDomain(),
      // From app.module.ts to modules
      appModuleToModule: importHelpers.appModuleToModule(fileNames.module.replace('.ts', '')),
      appModuleToTrpcModule: importHelpers.appModuleToTrpcModule(`${name}-trpc.module`),
      // From repository to constants (relative path)
      repositoryToConstants: importHelpers.repositoryToConstants(),
      // For domain/index.ts export
      domainExport: isNested ? `./${name}` : null,
      // Electric-related imports
      controllerToAuthGuard: importHelpers.controllerToAuthGuard(),
      controllerToCurrentUser: importHelpers.controllerToCurrentUser(),
      controllerToElectricService: importHelpers.controllerToElectricService(),
      moduleToElectricModule: importHelpers.moduleToElectricModule(),
    };

    // Type mappings
    const tsTypes = {
      string: "string",
      integer: "number",
      decimal: "number",
      boolean: "boolean",
      uuid: "string",
      date: "Date",
      datetime: "Date",
      json: "unknown",
      string_array: "string[]",
      entity_ref: "EntityRef", // Placeholder - handled specially
      enum: "string", // Actual type generated from choices
    };

    const drizzleTypes = {
      string: "varchar",
      integer: "integer",
      decimal: "decimal",
      boolean: "boolean",
      uuid: "uuid",
      date: "date",
      datetime: "timestamp",
      json: "jsonb",
      string_array: "text_array",
      entity_ref: "entity_ref", // Placeholder - handled specially
      enum: "enum", // Placeholder - pgEnum generated
    };

    const zodTypes = {
      string: "z.string()",
      integer: "z.number().int()",
      // Drizzle maps PG `numeric` to JS string — z.coerce.string() avoids
      // silent precision loss. Aligned with clean-lite-ps (PR #42). See #43.
      decimal: "z.coerce.string()",
      boolean: "z.boolean()",
      uuid: "z.string().uuid()",
      date: "z.coerce.date()",
      datetime: "z.coerce.date()",
      json: "z.unknown()",
      string_array: "z.array(z.string())",
      entity_ref: "entity_ref", // Placeholder - handled specially
      enum: "z.enum()", // Placeholder - choices added
    };

    /**
     * Load choices from an external YAML file (for choices_from option)
     */
    const loadChoicesFromFile = (choicesFromPath, yamlDir) => {
      // Try relative to entities directory first
      const entitiesPath = path.resolve(
        process.cwd(),
        "entities",
        choicesFromPath,
      );
      if (fs.existsSync(entitiesPath)) {
        const content = fs.readFileSync(entitiesPath, "utf-8");
        const parsed = yaml.parse(content);
        // For relationship_types.yaml, extract keys from relationship_types section
        if (parsed.relationship_types) {
          return Object.keys(parsed.relationship_types);
        }
        // Otherwise extract top-level keys
        return Object.keys(parsed);
      }

      // Try relative to the YAML file directory
      const relativePath = path.resolve(yamlDir, choicesFromPath);
      if (fs.existsSync(relativePath)) {
        const content = fs.readFileSync(relativePath, "utf-8");
        const parsed = yaml.parse(content);
        if (parsed.relationship_types) {
          return Object.keys(parsed.relationship_types);
        }
        return Object.keys(parsed);
      }

      throw new Error(`choices_from file not found: ${choicesFromPath}`);
    };

    // Process fields for templates
    const processedFields = [];
    const entityRefFields = []; // Track entity_ref fields for special handling

    for (const [fieldName, field] of Object.entries(fields)) {
      // Skip 'id' field - it's always added explicitly in templates to avoid duplicates
      if (fieldName === 'id') continue;

      // Handle entity_ref type specially - generates TWO fields
      if (field.type === "entity_ref") {
        const allowedTypes = field.allowed_types || [];
        const baseName = fieldName;
        const baseCamel = camelCase(fieldName);

        // Track for later use (composite indexes, query methods)
        entityRefFields.push({
          name: baseName,
          camelName: baseCamel,
          pascalName: pascalCase(baseName),
          allowedTypes,
          required: field.required ?? false,
          nullable: field.nullable ?? false,
        });

        // Generate the type field (enum)
        processedFields.push({
          name: `${baseName}_entity_type`,
          camelName: `${baseCamel}EntityType`,
          type: "entity_ref_type",
          tsType: "EntityType",
          drizzleType: "entity_type_enum",
          zodType: "entityTypeSchema",
          required: field.required ?? false,
          nullable: field.nullable ?? false,
          isEntityRefType: true,
          entityRefBase: baseName,
          allowedTypes,
          // UI metadata for entity ref
          ui_type: "enum",
          ui_label: formatLabel(`${baseName} type`),
          ui_importance: "secondary",
          ui_group: "relationships",
          ui_visible: false,
        });

        // Generate the id field (uuid)
        processedFields.push({
          name: `${baseName}_entity_id`,
          camelName: `${baseCamel}EntityId`,
          type: "entity_ref_id",
          tsType: "string",
          drizzleType: "uuid",
          zodType: "z.string().uuid()",
          required: field.required ?? false,
          nullable: field.nullable ?? false,
          isEntityRefId: true,
          entityRefBase: baseName,
          // UI metadata
          ui_type: "text",
          ui_label: formatLabel(`${baseName} id`),
          ui_importance: "secondary",
          ui_group: "relationships",
          ui_visible: false,
        });

        continue; // Skip normal processing
      }

      // Handle enum type with choices or choices_from
      let choices = field.choices;
      if (field.type === "enum" && field.choices_from) {
        try {
          choices = loadChoicesFromFile(field.choices_from, path.dirname(fullPath));
        } catch (e) {
          console.warn(
            `Warning: Could not load choices from ${field.choices_from}: ${e.message}`,
          );
          choices = [];
        }
      }

      const hasChoices = Array.isArray(choices) && choices.length > 0;

      // For choice fields, generate literal union type instead of string
      let tsType = tsTypes[field.type] || "unknown";
      if (hasChoices) {
        tsType = choices.map((c) => `'${c}'`).join(" | ");
      }

      // For choice fields, we'll use pgEnum instead of varchar
      let drizzleType = drizzleTypes[field.type] || "varchar";
      if (hasChoices || field.type === "enum") {
        drizzleType = "enum"; // Special marker for enum handling
      }

      let zodType = zodTypes[field.type] || "z.unknown()";
      if (hasChoices) {
        zodType = `z.enum([${choices.map((c) => `'${c}'`).join(", ")}])`;
      }

      // Generate enum name for Drizzle pgEnum. Namespace the const + pg TYPE
      // name by entity (`opportunity_status` / `opportunityStatusEnum`) so two
      // entities that each declare a same-named enum field (e.g. `status`,
      // `role`) don't emit a duplicate `export const statusEnum` (TS2308) or a
      // duplicate `CREATE TYPE status` (a migration conflict). The COLUMN name
      // stays the bare field name — only the type + export are namespaced.
      const enumDbName = hasChoices
        ? (name ? `${name}_${fieldName}` : fieldName)
        : null;
      const enumName = hasChoices ? camelCase(enumDbName) + "Enum" : null;

      // Infer UI metadata with defaults
      const ui_type = inferUiType(fieldName, field);
      const ui_label = field.ui_label || formatLabel(fieldName);
      const ui_importance = inferUiImportance(fieldName, field);
      const ui_group = inferUiGroup(fieldName, field);
      const ui_sortable = field.ui_sortable ?? false;
      const ui_filterable = field.ui_filterable ?? false;
      // Default visibility: hide id and timestamp fields
      const ui_visible =
        field.ui_visible ??
        !["id", "created_at", "updated_at", "deleted_at"].includes(fieldName);

      processedFields.push({
        name: fieldName,
        camelName: camelCase(fieldName),
        type: field.type,
        tsType,
        drizzleType,
        zodType,
        required: field.required ?? false,
        nullable: field.nullable ?? false,
        maxLength: field.max_length,
        minLength: field.min_length,
        min: field.min,
        max: field.max,
        choices,
        choicesFrom: field.choices_from,
        hasChoices,
        enumName,
        enumDbName,
        default: field.default,
        index: field.index ?? false,
        unique: field.unique ?? false,
        foreignKey: field.foreign_key,
        // UI metadata
        ui_type,
        ui_label,
        ui_importance,
        ui_group,
        ui_sortable,
        ui_filterable,
        ui_visible,
        ui_placeholder: field.ui_placeholder,
        ui_help: field.ui_help,
        ui_format: field.ui_format,
      });
    }

    // Collect enum fields for Drizzle pgEnum generation
    const enumFields = processedFields.filter((f) => f.hasChoices);

    // Process relationships by type
    const belongsToRelations = Object.entries(relationships)
      .filter(([_, rel]) => rel.type === "belongs_to")
      .map(([relName, rel]) => ({
        name: relName,
        type: "belongs_to",
        target: rel.target,
        targetClass: pascalCase(rel.target),
        targetPlural: pluralize(rel.target),
        targetPluralClass: pascalCase(pluralize(rel.target)),
        foreignKey: rel.foreign_key,
        foreignKeyCamel: camelCase(rel.foreign_key),
        foreignKeyPascal: pascalCase(rel.foreign_key),
      }));

    const hasManyRelations = Object.entries(relationships)
      .filter(([_, rel]) => rel.type === "has_many")
      .map(([relName, rel]) => ({
        name: relName,
        type: "has_many",
        target: rel.target,
        targetClass: pascalCase(rel.target),
        targetPlural: pluralize(rel.target),
        targetPluralClass: pascalCase(pluralize(rel.target)),
        inverseForeignKey: rel.foreign_key,
        inverseForeignKeyCamel: camelCase(rel.foreign_key),
      }));

    const hasOneRelations = Object.entries(relationships)
      .filter(([_, rel]) => rel.type === "has_one")
      .map(([relName, rel]) => ({
        name: relName,
        type: "has_one",
        target: rel.target,
        targetClass: pascalCase(rel.target),
        targetPlural: pluralize(rel.target),
        inverseForeignKey: rel.foreign_key,
        inverseForeignKeyCamel: camelCase(rel.foreign_key),
      }));

    // All relationships combined
    const allRelationships = [
      ...belongsToRelations,
      ...hasManyRelations,
      ...hasOneRelations,
    ];

    // Check which related entities have generated domain files
    // This allows the repository to skip importing entities that don't exist yet
    const checkEntityExists = (targetName) => {
      const domainBase = `${BASE_PATHS.backendSrc}/domain`;
      const nestedPath = path.resolve(
        process.cwd(),
        `${domainBase}/${targetName}/${targetName}.entity.ts`,
      );
      const flatPath = path.resolve(
        process.cwd(),
        `${domainBase}/${targetName}.entity.ts`,
      );
      return fs.existsSync(nestedPath) || fs.existsSync(flatPath);
    };

    // Mark each relationship with whether its target entity exists
    for (const rel of allRelationships) {
      rel.targetExists = checkEntityExists(rel.target);
    }
    for (const rel of belongsToRelations) {
      rel.targetExists = checkEntityExists(rel.target);
    }
    for (const rel of hasManyRelations) {
      rel.targetExists = checkEntityExists(rel.target);
    }
    for (const rel of hasOneRelations) {
      rel.targetExists = checkEntityExists(rel.target);
    }

    // Filter to only relationships with existing targets for repository imports
    const existingRelationships = allRelationships.filter(
      (r) => r.targetExists,
    );
    const existingBelongsTo = belongsToRelations.filter((r) => r.targetExists);
    const existingHasMany = hasManyRelations.filter((r) => r.targetExists);
    const existingHasOne = hasOneRelations.filter((r) => r.targetExists);

    // Convenience flags
    const hasRelationships = allRelationships.length > 0;
    const hasExistingRelationships = existingRelationships.length > 0;
    const hasBelongsTo = belongsToRelations.length > 0;
    const hasHasMany = hasManyRelations.length > 0;
    const hasHasOne = hasOneRelations.length > 0;

    // Legacy format for backward compatibility
    const processedRelationships = allRelationships;

    // Separate required vs optional fields for DTOs
    const requiredFields = processedFields.filter((f) => f.required);
    const optionalFields = processedFields.filter((f) => !f.required);

    // Compute which Drizzle imports are needed (always need pgTable, uuid for id)
    // Note: timestamp is NOT always needed - only if behaviors include timestamps or soft_delete
    const drizzleImportsNeeded = new Set(["pgTable", "uuid"]);

    // Add pgEnum if we have any enum fields
    if (enumFields.length > 0) {
      drizzleImportsNeeded.add("pgEnum");
    }

    // Check if we have entity_ref fields (need to import entity type enum)
    const hasEntityRefFields = entityRefFields.length > 0;
    if (hasEntityRefFields) {
      drizzleImportsNeeded.add("pgEnum");
    }

    for (const field of processedFields) {
      // Map drizzle type to import name (skip 'enum' as it's handled via pgEnum)
      const importMap = {
        varchar: "varchar",
        integer: "integer",
        decimal: "numeric",
        boolean: "boolean",
        uuid: "uuid",
        date: "date",
        timestamp: "timestamp",
        jsonb: "jsonb",
        text_array: "text",
      };
      const importName = importMap[field.drizzleType];
      if (importName) {
        drizzleImportsNeeded.add(importName);
      }
    }

    // Add Drizzle imports from behaviors
    for (const imp of resolvedBehaviors.drizzleImports) {
      drizzleImportsNeeded.add(imp);
    }

    const drizzleImports = Array.from(drizzleImportsNeeded).sort();

    // Get database dialect from config
    const databaseDialect = getDatabaseDialect();

    // Derive Electric where clause FK field from entity fields
    // Look for foreign_key to users or tenants
    let electricWhereColumn = 'tenant_id'; // fallback
    let electricWhereValue = 'user.tenantId'; // fallback

    for (const field of processedFields) {
      if (field.foreignKey) {
        // Check if it references users table
        if (field.foreignKey.startsWith('users.')) {
          electricWhereColumn = field.name;
          electricWhereValue = `user.${field.camelName}`;
          break;
        }
        // Check if it references tenants table
        if (field.foreignKey.startsWith('tenants.')) {
          electricWhereColumn = field.name;
          electricWhereValue = `user.${field.camelName}`;
          // Don't break - users FK takes precedence
        }
      }
    }

    // ============================================================================
    // Architecture Target + pipeline gates (from generate config)
    //
    // `generate.architecture` is the single source of truth for which backend
    // template set runs. Values:
    //   - 'clean'         → templates/entity/new/backend/ (Clean Architecture)
    //   - 'clean-lite-ps' → templates/entity/new/clean-lite-ps/ (modules/ layout)
    //
    // `generate.frontend` gates the frontend pipeline entirely.
    // ============================================================================

    const generateConfig = getGenerateConfig();
    const architectureTarget = generateConfig.architecture;
    const isCleanArchitecture = architectureTarget === 'clean';
    const isCleanLitePs = architectureTarget === 'clean-lite-ps';

    // ============================================================================
    // v2: Queries
    // ============================================================================

    /**
     * Derive a camelCase method name from a query spec.
     *
     * Rules:
     *   select present → findXsByY  (e.g., select:[email], by:[opportunity_id] → findEmailsByOpportunityId)
     *   otherwise      → findByX    (e.g., by:[user_id] → findByUserId)
     *                                (e.g., by:[user_id, account_id] → findByUserIdAndAccountId)
     */
    function deriveQueryMethodName(query) {
      const byFields = Array.isArray(query.by) ? query.by : [];
      const selectFields = Array.isArray(query.select) ? query.select : [];

      // Convert snake_case field list to PascalCase joined by "And"
      const byPart = byFields.map((f) => pascalCase(f)).join('And');

      if (selectFields.length > 0) {
        // findEmailsByOpportunityId — select fields come first (plural implied)
        const selectPart = selectFields.map((f) => pascalCase(f)).join('And') + 's';
        return `find${selectPart}By${byPart}`;
      }

      return `findBy${byPart}`;
    }

    const hasQueries = queriesBlock != null && queriesBlock.length > 0;

    // Build a lookup of field name → TS type for query param resolution
    const fieldTypeMap = {};
    for (const pf of processedFields) {
      fieldTypeMap[pf.name] = pf.tsType;
      fieldTypeMap[pf.camelName] = pf.tsType;
    }

    const processedQueries = hasQueries
      ? queriesBlock.map((q) => {
          const byFields = Array.isArray(q.by) ? q.by : [];
          const selectFields = Array.isArray(q.select) ? q.select : [];
          const isUnique = q.unique ?? false;
          const viaTable = q.via ?? null;

          // Build typed params from by fields
          const params = byFields.map((f) => ({
            name: f,
            camelName: camelCase(f),
            tsType: fieldTypeMap[f] || fieldTypeMap[camelCase(f)] || 'string',
          }));

          // Parse order: "created_at desc" → { column, direction }
          let orderBy = null;
          let orderDirection = null;
          if (q.order) {
            const parts = q.order.trim().split(/\s+/);
            orderBy = camelCase(parts[0]);
            orderDirection = parts[1] || 'asc';
          }

          // Derive method name
          const methodName = deriveQueryMethodName(q);

          // Derive return type
          let returnType;
          if (isUnique) {
            returnType = `${className} | null`;
          } else if (selectFields.length > 0) {
            // Projection — return picked fields
            const camelFields = selectFields.map((f) => camelCase(f));
            returnType = selectFields.length === 1
              ? `${fieldTypeMap[selectFields[0]] || fieldTypeMap[camelFields[0]] || 'string'}[]`
              : `Pick<${className}, ${camelFields.map((f) => `'${f}'`).join(' | ')}>[]`;
          } else {
            returnType = `${className}[]`;
          }

          // Use case class name
          const useCaseClassName = pascalCase(methodName) + queryLayerSuffix;

          return {
            // Raw YAML fields
            by: byFields,
            unique: isUnique,
            select: selectFields,
            order: q.order ?? null,
            limit: q.limit ?? null,
            via: viaTable,
            // Derived
            methodName,
            returnType,
            params,
            isUnique,
            orderBy,
            orderDirection,
            viaTable,
            viaTableCamel: viaTable ? camelCase(viaTable) : null,
            selectFields: selectFields.map((f) => camelCase(f)),
            useCaseClassName,
            // Convenience flags
            hasVia: viaTable != null,
            hasSelect: selectFields.length > 0,
            hasOrder: q.order != null,
            hasLimit: q.limit != null,
            hasMultipleParams: params.length > 1,
          };
        })
      : [];

    const hasDeclarativeQueries = processedQueries.length > 0;
    const declarativeQueryClasses = processedQueries.map((q) => q.useCaseClassName);

    // Check if any query needs 'and' import (multi-field WHERE)
    const hasMultiFieldQuery = processedQueries.some((q) => q.hasMultipleParams);
    // Check if any query needs 'desc'/'asc' import (ordered)
    const hasOrderedQuery = processedQueries.some((q) => q.hasOrder);

    // ============================================================================
    // v2: Integration
    // ============================================================================

    // ADR-033.1 / ADR-033.2: provider-keyed detection block.
    // Provider key order is YAML insertion order (preserved by yaml.parse).
    const detectionBlock = (definition.detection && typeof definition.detection === 'object')
      ? definition.detection
      : null;
    const detectionProviders = detectionBlock ? Object.keys(detectionBlock) : [];
    const hasDetection = detectionProviders.length > 0;

    // Render the per-entity DetectionConfigs map as a TS object literal.
    // JSON.stringify produces valid TS for the canonical DetectionConfig shape
    // (strings, numbers, booleans, arrays, plain objects). Provider keys keep
    // YAML insertion order. Used by integration-source.ejs.t.
    const detectionConfigsLiteral = hasDetection
      ? JSON.stringify(detectionBlock, null, 2)
      : '{}';

    const hasIntegrationBlock = integrationBlock != null;
    const integrationElectric = hasIntegrationBlock ? (integrationBlock.electric ?? false) : false;
    const rawIntegrationProviders = hasIntegrationBlock ? (integrationBlock.providers ?? {}) : {};
    const hasIntegrationProviders = Object.keys(rawIntegrationProviders).length > 0;

    const integrationProviders = hasIntegrationProviders
      ? Object.entries(rawIntegrationProviders).map(([providerName, cfg]) => {
          // Normalize field_mapping: { local: key, remote: value }[]
          const rawMapping = cfg.field_mapping ?? {};
          const fieldMapping = Object.entries(rawMapping).map(([local, remote]) => ({
            local,
            remote,
          }));

          return {
            name: providerName,
            remoteEntity: cfg.remote_entity ?? null,
            direction: cfg.direction ?? 'bidirectional',
            cdc: cfg.cdc ?? false,
            fieldMapping,
            readOnlyFields: cfg.read_only_fields ?? [],
          };
        })
      : [];

    // ============================================================================
    // v2: Events
    // ============================================================================

    const hasEvents = eventsBlock != null && eventsBlock.length > 0;
    const processedEvents = hasEvents
      ? eventsBlock.map((ev) => {
          // Convert body: { field: type } to array of { field, type }
          const rawBody = ev.body ?? {};
          const body = Object.entries(rawBody).map(([field, type]) => ({ field, type }));

          // Derive class names from event name (snake_case → PascalCase + Event)
          const className = pascalCase(ev.name) + 'Event';
          const handlerClassName = pascalCase(ev.name) + 'Handler';

          return {
            name: ev.name,
            queue: ev.queue ?? null,
            body,
            generateHandler: ev.generate_handler ?? false,
            className,
            handlerClassName,
          };
        })
      : [];

    // ============================================================================
    // EVT-7: emits — resolve typed events for create/update/delete use-cases.
    // ============================================================================
    //
    // The `emits:` list is guaranteed-valid at this point — the CLI pre-flight
    // (`validateEntityEmits`) has already run. Our job is to derive:
    //   • `emitsEvents[]` — one entry per emitted type with payload + mapping.
    //   • `createEventType` / `updateEventType` / `deleteEventType` — the specific
    //     `<entity>_<op>` entries for the three standard CRUD use-cases.
    //   • Payload mapping rules 1..5 (see plan §Payload mapping).
    //
    // We re-merge `events/*.yaml` + entity desugar here because we cannot
    // import the TS generator helpers into a Hygen prompt. The merge is cheap
    // and has no side effects; the validator has already proven correctness.

    const hasEmits = Array.isArray(emitsBlock) && emitsBlock.length > 0;

    const FIELD_TYPE_TO_TS = {
      uuid: 'string',
      string: 'string',
      number: 'number',
      boolean: 'boolean',
      date: 'Date',
      json: 'Record<string, unknown>',
    };

    // Load top-level events/<name>.yaml, tolerant of missing dir / bad files.
    const loadTopLevelEventYamls = (eventsDir) => {
      if (!fs.existsSync(eventsDir)) return new Map();
      const byType = new Map();
      for (const file of fs.readdirSync(eventsDir)) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
        try {
          const content = fs.readFileSync(path.join(eventsDir, file), 'utf-8');
          const parsed = yaml.parse(content);
          if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
            byType.set(parsed.type, parsed);
          }
        } catch {
          // Silently skip — the main event-codegen-generator surfaces parse errors.
        }
      }
      return byType;
    };

    // Desugar entity events: block into top-level-event shape with
    // `{ type, direction: 'change', aggregate, payload: { <key>: { type, nullable } } }`.
    const desugarEntityEventsInline = (entityDefinition) => {
      const out = new Map();
      const entityName = entityDefinition?.entity?.name;
      const evs = entityDefinition?.events ?? [];
      for (const ev of evs) {
        const payload = {};
        for (const [key, t] of Object.entries(ev.body ?? {})) {
          payload[key] = { type: t, nullable: false };
        }
        out.set(ev.name, {
          type: ev.name,
          direction: 'change',
          aggregate: entityName,
          payload,
        });
      }
      return out;
    };

    /**
     * Resolve each emit name into the per-op event descriptor the templates need.
     */
    const resolveEmitsEvents = () => {
      if (!hasEmits) return [];

      const eventsDir = path.resolve(process.cwd(), 'events');
      const topLevel = loadTopLevelEventYamls(eventsDir);
      const sugar = desugarEntityEventsInline(definition);
      // Top-level wins on collision (same policy as event-codegen-generator).
      const merged = new Map(sugar);
      for (const [k, v] of topLevel) merged.set(k, v);

      // Build quick lookups keyed by camelCase for payload-mapping rules 3/4.
      const entityKeysCamel = new Set(
        processedFields.map((f) => f.camelName),
      );

      // DTO keys = the fields actually present on CreateXDto (input-eligible).
      // The CLP + Clean DTOs derive from the same processedFields list (minus
      // behaviors-computed fields like createdAt/updatedAt/deletedAt). We
      // approximate here by using all processedFields — the TODO comments on
      // each generated line make any miss visually obvious.
      const dtoKeysCamel = new Set(
        processedFields.map((f) => f.camelName),
      );

      return emitsBlock.map((emitName) => {
        const ev = merged.get(emitName);
        // `validateEntityEmits` has already guaranteed `ev` is defined. If
        // somehow we get here with an unknown name (e.g. validator bypassed),
        // emit a TODO-only mapping so the generated file still parses.
        const payload = ev?.payload ?? {};
        const payloadKeys = Object.keys(payload).sort();

        const payloadMap = payloadKeys.map((snakeKey) => {
          const field = payload[snakeKey];
          const tsType = FIELD_TYPE_TO_TS[field.type] ?? 'unknown';
          const tsTypeFinal = field.nullable ? `${tsType} | null` : tsType;
          const camelKey = camelCase(snakeKey);

          let expression;
          let todo;

          // Rule 1: <entity>_id or <entityName>Id → entity.id
          if (
            snakeKey === `${name}_id` ||
            camelKey === `${camelName}Id`
          ) {
            expression = 'entity.id';
          }
          // Rule 2: created_by / updated_by → dto.createdBy / dto.updatedBy if present.
          else if (snakeKey === 'created_by' || snakeKey === 'updated_by') {
            const dtoKey = camelKey;
            if (dtoKeysCamel.has(dtoKey)) {
              expression = `dto.${dtoKey}`;
            } else {
              expression = `null as unknown as ${tsTypeFinal}`;
              todo = `supply ${snakeKey} (not on DTO — wire from auth context)`;
            }
          }
          // Rule 3: field present on just-created entity → entity.<camelKey>
          else if (entityKeysCamel.has(camelKey)) {
            expression = `entity.${camelKey}`;
          }
          // Rule 4: field present on input DTO (fallback) → dto.<camelKey>
          else if (dtoKeysCamel.has(camelKey)) {
            expression = `dto.${camelKey}`;
          }
          // Rule 5: otherwise — null placeholder + TODO.
          else {
            expression = `null as unknown as ${tsTypeFinal}`;
            todo = `supply ${snakeKey}`;
          }

          return {
            snakeKey,
            camelKey,
            tsType: tsTypeFinal,
            expression,
            todo,
          };
        });

        return {
          type: emitName,
          aggregate: ev?.aggregate ?? name,
          payloadMap,
        };
      });
    };

    const emitsEvents = resolveEmitsEvents();
    const createEventType =
      emitsEvents.find((e) => e.type === `${name}_created`) ?? null;
    const updateEventType =
      emitsEvents.find((e) => e.type === `${name}_updated`) ?? null;
    const deleteEventType =
      emitsEvents.find((e) => e.type === `${name}_deleted`) ?? null;

    // Import paths for the TypedEventBus token + DrizzleClient token/type.
    // Mode-resolved (ADR-037): in `vendored` mode the consumer app wires
    // `@shared/*` aliases to the vendored runtime under `src/shared/…`
    // (subsystem barrel at `<subsystems_root>/events/index.ts`); in `package`
    // mode they resolve to `@pattern-stack/codegen/subsystems` +
    // `@pattern-stack/codegen/runtime/…`.
    const eventsTokenImport = subsystemsImport(runtimeMode, 'events');
    const typedEventBusImport = subsystemsImport(runtimeMode, 'events');
    const drizzleTokenImport = runtimeImport(runtimeMode, 'constants/tokens');
    const drizzleTypeImport = runtimeImport(runtimeMode, 'types/drizzle');
    // Pagination contract (pagination-by-default). ASYMMETRIC by mode:
    //   - package  → `@pattern-stack/codegen/runtime/http/pagination` (Page<T>,
    //     ListQuerySchema, resolveListQuery, buildPage, cursor codec) — the
    //     package-published runtime; swe-brain consumes this green.
    //   - vendored → `@shared/http/page` (vendored to `src/shared/http/page.ts`
    //     by project init's VENDORED_RUNTIME_FILES). DISTINCT from the consumer's
    //     OPTIONAL `@shared/http/pagination` search contract ({items,total,limit,
    //     offset}) — vendoring the Page<T> envelope to `/pagination` would
    //     clobber it, so the list envelope lives at `/page`.
    // Unlike most @shared/http/* files (which the package never owns), THIS one
    // IS package-published — the list endpoint is unconditional, so its contract
    // must ship with codegen (package mode) and be vendored (vendored mode).
    const paginationImport =
      runtimeMode === 'vendored'
        ? '@shared/http/page'
        : runtimeImport(runtimeMode, 'http/pagination');
    // Integration subsystem barrel (ADR-033.1 inline-sync `integration-source`
    // module — emitted only for entities with an inline `detection:` block).
    const integrationSubsystemImport = subsystemsImport(runtimeMode, 'integration');

    // Remaining runtime-owned import specifiers the clean-lite-ps templates emit
    // (ADR-037 — mode-resolved). Consumer-app files the package never owns
    // (`@shared/database/*`, `@shared/http/*`) stay `@shared/*` in both modes and
    // are NOT in this set.
    const withAnalyticsImport = runtimeImport(runtimeMode, 'base-classes/with-analytics');
    const integrationUpsertConfigImport = runtimeImport(runtimeMode, 'base-classes/integration-upsert-config');
    const baseRepositoryImport = runtimeImport(runtimeMode, 'base-classes/base-repository');
    const eavHelpersImport = runtimeImport(runtimeMode, 'eav-helpers');
    const zodValidationPipeImport = runtimeImport(runtimeMode, 'pipes/zod-validation.pipe');
    // OpenAPI barrel: the runtime source lives at `runtime/shared/openapi`, but
    // the VENDORED target drops the leading `shared/` (vendored alias is
    // `@shared/openapi`, NOT `@shared/shared/openapi`). Package mode keeps the
    // full runtime relpath. So this one is asymmetric — special-case it.
    const openApiImport =
      runtimeMode === 'vendored' ? '@shared/openapi' : runtimeImport(runtimeMode, 'shared/openapi');

    // @generated banner — single line stamped at the top of every
    // force-overwritten output. `yamlPath` is the consumer-relative source
    // (e.g. `entities/opportunity.yaml`). Extension seam differs by
    // architecture: clean-lite-ps customises via patterns, clean via the
    // base-class behavior config / repository subclass.
    const generatedBanner = renderGeneratedBanner({
      // Relative to cwd so the banner is portable across machines (an absolute
      // path would bake a developer's checkout root into every output).
      source: path.relative(process.cwd(), fullPath),
      generator: 'entity',
      seam: isCleanLitePs
        ? 'a pattern (src/patterns/*.pattern.ts) or the entity YAML'
        : 'the entity YAML or a base-class behavior config',
    });

    const locals = {
      // @generated DO-NOT-EDIT banner (see renderGeneratedBanner)
      generatedBanner,

      // Runtime mode (ADR-037) — drives runtime import specifiers; read by the
      // clean-lite-ps prompt-extension to rewrite base-class imports.
      runtimeMode,

      // Database configuration
      databaseDialect,
      schemaDir: BASE_PATHS.schemaDir,

      // Project layout — used by clean-lite-ps prompt-extension to compute
      // output paths under the configured source root (paths.backend_src).
      backendSrc: BASE_PATHS.backendSrc,

      // Entity names
      name,
      plural,
      table,
      className,
      classNamePlural,
      camelName,
      repositoryToken,

      // Fields
      fields: processedFields,
      requiredFields,
      optionalFields,
      enumFields,

      // Entity reference fields (polymorphic refs)
      entityRefFields,
      hasEntityRefFields,

      // Relationships - separated by type
      relationships: allRelationships,
      belongsToRelations,
      hasManyRelations,
      hasOneRelations,

      // Relationship flags
      hasRelationships,
      hasExistingRelationships,
      hasBelongsTo,
      hasHasMany,
      hasHasOne,

      // Filtered relationships (only those with existing target entities)
      existingRelationships,
      existingBelongsTo,
      existingHasMany,
      existingHasOne,

      // Drizzle imports (only what's needed)
      drizzleImports,

      // Layout configuration
      // folder_structure: "nested" | "flat" - controls directory nesting
      // file_grouping: "separate" | "grouped" - controls file organization
      layout,
      folderStructure,
      fileGrouping,
      isNested,
      isGrouped,
      paths,
      fileNames,
      imports,

      // Base paths for templates (from centralized config)
      basePaths: BASE_PATHS,
      backendLayers: BACKEND_LAYERS,

      // Unified locations (path + import alias)
      // Usage: locations.dbEntities.path, locations.dbEntities.import
      locations: LOCATIONS,

      // NOTE: the `frontend:` locals block (auth/sync/parsers/collections) was
      // deleted with the hygen frontend templates (FE-3). The frontend emitter
      // (src/emitters/frontend/) now reads `frontend.*` from codegen.config.yaml
      // directly into its own FrontendEmitConfig — no template ever consumed
      // these locals after the templates were removed.

      // Naming configuration (for templates that need it)
      namingConfig,
      applicationLayerSuffix,
      queryLayerSuffix,

      // Pre-computed class names with configured terminology
      createCommandClass,
      updateCommandClass,
      deleteCommandClass,
      getByIdQueryClass,
      listQueryClass,

      // Generation toggles (backend only — what to generate).
      //
      // The frontend toggles (fieldMetadata/collections/collectionsIndex/hooks/
      // mutations/hookStyle/structure/typeNaming/fkResolution/collectionNaming/
      // fileNaming/hookReturnStyle) were deleted with the hygen frontend
      // templates (FE-3). The frontend tree is now emitted by
      // src/emitters/frontend/ and gated solely by `generate.frontend`.
      generate: {
        drizzleSchema: getProjectConfig()?.generate?.drizzleSchema ?? true,
        commands: getProjectConfig()?.generate?.commands ?? true,
        queries: getProjectConfig()?.generate?.queries ?? true,
        dtos: getProjectConfig()?.generate?.dtos ?? true,
        schemaServer: getProjectConfig()?.generate?.schemaServer ?? false,
        schemaClient: getProjectConfig()?.generate?.schemaClient ?? false,
        electricMigrations: getProjectConfig()?.generate?.electricMigrations ?? false,
      },

      // Pre-computed output paths for templates (avoids ternary in YAML frontmatter)
      outputPaths,

      // Behavior strategy and resolved behaviors
      behaviorStrategy,
      behaviors: resolvedBehaviors,
      behaviorFields: resolvedBehaviors.fields,
      hasBehaviors: resolvedBehaviors.hasBehaviors,
      hasTimestamps: resolvedBehaviors.hasTimestamps,
      hasSoftDelete: resolvedBehaviors.hasSoftDelete,
      hasUserTracking: resolvedBehaviors.hasUserTracking,
      hasTemporalValidity: resolvedBehaviors.hasTemporalValidity,
      repositoryBehaviorConfig: resolvedBehaviors.repositoryConfig,

      // Expose configuration (which layers to generate)
      expose: entity.expose || ["repository", "rest", "trpc"],
      exposeRepository: (
        entity.expose || ["repository", "rest", "trpc"]
      ).includes("repository"),
      exposeRest: (entity.expose || ["repository", "rest", "trpc"]).includes(
        "rest",
      ),
      exposeTrpc: (entity.expose || ["repository", "rest", "trpc"]).includes(
        "trpc",
      ),
      exposeElectric: (
        entity.expose || ["repository", "rest", "trpc"]
      ).includes("electric"),

      // Electric SQL where clause (derived from entity FK fields)
      electricWhereColumn,
      electricWhereValue,

      // ======================================================================
      // v2 variables
      // ======================================================================

      // Architecture target (from generate.architecture config)
      architectureTarget,
      isCleanArchitecture,
      isCleanLitePs,

      // Queries
      hasQueries,
      processedQueries,
      hasDeclarativeQueries,
      declarativeQueryClasses,
      hasMultiFieldQuery,
      hasOrderedQuery,

      // Integration
      hasIntegrationBlock,
      integrationElectric,
      hasIntegrationProviders,
      integrationProviders,

      // Detection (ADR-033.1 / ADR-033.2 typed provider artifacts)
      hasDetection,
      detectionProviders,
      detectionConfigsLiteral,

      // Events
      hasEvents,
      processedEvents,

      // EVT-7: emits (typed auto-emission via TypedEventBus)
      hasEmits,
      emitsEvents,
      createEventType,
      updateEventType,
      deleteEventType,
      eventsTokenImport,
      typedEventBusImport,
      drizzleTokenImport,
      drizzleTypeImport,
      paginationImport,
      integrationSubsystemImport,
      withAnalyticsImport,
      integrationUpsertConfigImport,
      baseRepositoryImport,
      eavHelpersImport,
      zodValidationPipeImport,
      openApiImport,
    };

    // ========================================================================
    // Clean-Lite-PS template locals
    //
    // Populated only when `generate.architecture === 'clean-lite-ps'`.
    // When the architecture is 'clean', stub locals are injected so CLP
    // template bodies can render without crashing; their `to:` guards resolve
    // to null which causes Hygen to skip file writing.
    // ========================================================================
    // EVT-7 note: hasEmits / emitsEvents / *EventType / *Import locals are
    // already in `locals` above and are architecture-neutral — CLP templates
    // read the same locals to render typed publish blocks in their use-cases.

    if (isCleanLitePs) {
      // Load app-defined patterns (if any) into the registry before the
      // clean-lite-ps extension reads it. `loadAppPatterns` is idempotent
      // and deterministic — calling it every run is cheap (one dynamic
      // import per pattern file) and matches the two-process load story
      // the registry tests pin down.
      await ensurePatternsRegistryLoaded();
      const { buildCleanLitePsLocals } = await import('./clean-lite-ps/prompt-extension.js');
      Object.assign(locals, buildCleanLitePsLocals(definition, locals));
    } else {
      // Inject safe stub locals so CLP template bodies can render without crashing.
      // The to: guard resolves to "null" which causes Hygen to skip file writing.
      const _n = definition.entity?.name || '';
      const _p = definition.entity?.plural || _n + 's';
      Object.assign(locals, {
        clpOutputPaths: undefined,
        clpImports: undefined,
        entityName: _n,
        entityNamePlural: _p,
        entityNamePascal: _n,
        entityNamePluralPascal: _p,
        classNames: {},
        clpDrizzleImports: [],
        clpProcessedFields: [],
        clpCreateDtoFields: [],
        clpOutputDtoFields: [],
        clpBelongsTo: [],
        clpBelongsToFkFields: [],
        clpHasRelationsBlock: false,
        repositoryBaseClass: '',
        serviceBaseClass: '',
        repositoryBaseImport: '',
        serviceBaseImport: '',
        repositoryInheritedMethods: [],
        serviceInheritedMethods: [],
        // Generation toggles — needed so CLP template bodies render without crashing
        // when architecture is 'clean'. The to:/skip_if: guards prevent file writes.
        generateWrites: true,
        eavEnabled: false,
        eavValueTable: false,
        eavDefinitionEntity: null,
        eavDefinitionEntityPlural: null,
        eavDefinitionPascal: null,
        eavDefinitionPluralPascal: null,
        hasSearchQuery: false,
        searchQuery: null,
        hasExternalIdTracking: false,
        // PATTERN-5 stubs — defined even for non-CLP architectures so the
        // CLP template bodies render without `ReferenceError`s. The
        // to:/skip_if: guards prevent file writes, but EJS still walks the
        // body on every template.
        patternName: 'Base',
        hasPatternConfig: false,
        patternConfig: null,
        renderPatternConfigLiteral: () => '{}',
      });
    }

    return locals;
  },
};
