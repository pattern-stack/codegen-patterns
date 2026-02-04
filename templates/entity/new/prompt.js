/**
 * Hygen prompt.js - Loads entity YAML and prepares template locals
 *
 * Usage: bunx hygen entity new --yaml entities/opportunity.yaml
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import {
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
} from "../../../config/paths.mjs";
import { getNamingConfig } from "../../../config/naming-config.mjs";

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
  const defaultConfig = { behaviors: { strategy: "base_class" } };

  if (!fs.existsSync(configPath)) {
    return defaultConfig;
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = yaml.parse(content);
    return {
      behaviors: {
        strategy: parsed?.behaviors?.strategy || "base_class",
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

    // Prepare locals for templates
    const entity = definition.entity;
    const fields = definition.fields || {};
    const relationships = definition.relationships || {};
    const behaviors = definition.behaviors || [];

    // Helper functions
    const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const camelCase = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const pascalCase = (s) => capitalize(camelCase(s));
    const pluralize = (s) => {
      if (s.endsWith("y")) return s.slice(0, -1) + "ies";
      if (
        s.endsWith("s") ||
        s.endsWith("x") ||
        s.endsWith("ch") ||
        s.endsWith("sh")
      )
        return s + "es";
      return s + "s";
    };

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

    // Frontend store naming
    const singularCamelName = camelCase(name); // "dealState" from "deal_state"
    const pluralCamelName = camelCase(plural); // "dealStates" from "deal_states"
    const collectionVarName = singularCamelName + "Collection"; // "dealStateCollection"
    const collectionVarNamePlural = pluralCamelName + "Collection"; // "dealStatesCollection"

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
      constants: importHelpers.constants,
      domain: importHelpers.domain,
      schemas: importHelpers.schemas,
      // From domain to other domain files (same folder when nested)
      domainEntity: importHelpers.domainEntity(name),
      // From module (modules/) to commands/queries
      moduleToGetByIdQuery: importHelpers.moduleToQuery(name, fileNames.getByIdQuery.replace('.ts', '')),
      moduleToListQuery: importHelpers.moduleToQuery(name, fileNames.listQuery.replace('.ts', '')),
      moduleToCreateCommand: importHelpers.moduleToCommand(name, fileNames.createCommand.replace('.ts', '')),
      moduleToUpdateCommand: importHelpers.moduleToCommand(name, fileNames.updateCommand.replace('.ts', '')),
      moduleToDeleteCommand: importHelpers.moduleToCommand(name, fileNames.deleteCommand.replace('.ts', '')),
      // From controller (presentation/rest/) to queries/commands
      controllerToGetByIdQuery: importHelpers.controllerToQuery(name, fileNames.getByIdQuery.replace('.ts', '')),
      controllerToListQuery: importHelpers.controllerToQuery(name, fileNames.listQuery.replace('.ts', '')),
      controllerToCreateCommand: importHelpers.controllerToCommand(name, fileNames.createCommand.replace('.ts', '')),
      controllerToUpdateCommand: importHelpers.controllerToCommand(name, fileNames.updateCommand.replace('.ts', '')),
      controllerToDeleteCommand: importHelpers.controllerToCommand(name, fileNames.deleteCommand.replace('.ts', '')),
      // For domain/index.ts export
      domainExport: isNested ? `./${name}` : null,
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
      decimal: "z.number()",
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

      // Generate enum name for Drizzle pgEnum (camelCase + 'Enum')
      const enumName = hasChoices ? camelCase(fieldName) + "Enum" : null;

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
        decimal: "doublePrecision",
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

    return {
      // Database configuration
      databaseDialect,
      schemaDir: BASE_PATHS.schemaDir,

      // Entity names
      name,
      plural,
      table,
      className,
      classNamePlural,
      camelName,
      repositoryToken,

      // Frontend store naming
      singularCamelName,
      pluralCamelName,
      collectionVarName,
      collectionVarNamePlural,

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

      // Unified locations (path + import alias)
      // Usage: locations.dbEntities.path, locations.dbEntities.import
      locations: LOCATIONS,

      // Frontend configuration
      // Note: Use hasOwnProperty checks for values where null is meaningful (disables the feature)
      frontend: {
        auth: {
          // null means "no auth function" - don't fall back to default
          function: getProjectConfig()?.frontend?.auth?.hasOwnProperty?.('function')
            ? getProjectConfig().frontend.auth.function
            : 'getAuthorizationHeader',
        },
        sync: {
          shapeUrl: getProjectConfig()?.frontend?.sync?.shapeUrl ?? '/v1/shape',
          useTableParam: getProjectConfig()?.frontend?.sync?.useTableParam ?? true,
          // Column mapper for snake_case to camelCase conversion (e.g., 'snakeCamelMapper')
          // Set to null/undefined if DB columns already match JS property names
          columnMapper: getProjectConfig()?.frontend?.sync?.columnMapper ?? null,
          // Whether to wrap shapeUrl in new URL() constructor
          wrapInUrlConstructor: getProjectConfig()?.frontend?.sync?.wrapInUrlConstructor ?? true,
          // Whether columnMapper needs () to call (true for functions, false for objects)
          columnMapperNeedsCall: getProjectConfig()?.frontend?.sync?.columnMapperNeedsCall ?? true,
          // Import path for API_BASE_URL (if needed)
          apiBaseUrlImport: getProjectConfig()?.frontend?.sync?.apiBaseUrlImport ?? null,
        },
        parsers: getProjectConfig()?.frontend?.parsers ?? {
          timestamptz: '(date: string) => new Date(date)',
        },
      },

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

      // Generation toggles (what to generate)
      generate: {
        fieldMetadata: getProjectConfig()?.generate?.fieldMetadata ?? true,
        collections: getProjectConfig()?.generate?.collections ?? true,
        hooks: getProjectConfig()?.generate?.hooks ?? true,
        mutations: getProjectConfig()?.generate?.mutations ?? true,
        // Hook style: 'collection' uses collection.useMany(), 'useLiveQuery' uses TanStack DB pattern
        hookStyle: getProjectConfig()?.generate?.hookStyle ?? 'collection',
        // Output structure mode: 'entity-first' | 'concern-first' | 'monolithic'
        // entity-first: generated/{entity}/types.ts, collection.ts, hooks.ts...
        // concern-first: generated/types/{entity}.ts, collections/{entity}.ts...
        // monolithic: generated/{entity}.ts (single file per entity)
        structure: getProjectConfig()?.generate?.structure ?? 'monolithic',
        // Type naming: 'plain' = Opportunity, 'entity' = OpportunityEntity
        typeNaming: getProjectConfig()?.generate?.typeNaming ?? 'plain',
        // FK resolution: true = import related collections, false = skip (useful when collections don't exist)
        fkResolution: getProjectConfig()?.generate?.fkResolution ?? true,
        // Collection variable naming: 'singular' = opportunityCollection, 'plural' = opportunitiesCollection
        collectionNaming: getProjectConfig()?.generate?.collectionNaming ?? 'singular',
        // File naming: 'singular' = opportunity.ts, 'plural' = opportunities.ts
        fileNaming: getProjectConfig()?.generate?.fileNaming ?? 'singular',
        // Hook return style: 'generic' = { data }, 'named' = { opportunities }
        hookReturnStyle: getProjectConfig()?.generate?.hookReturnStyle ?? 'generic',
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
    };
  },
};
