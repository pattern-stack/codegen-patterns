/**
 * Hygen prompt.js — Loads junction YAML and prepares template locals
 *
 * Usage: bunx hygen junction new --yaml junctions/opportunity_contact.yaml
 *
 * Mirrors templates/relationship/new/prompt.js but adapted for junction
 * definitions (two endpoints, role enum, BaseJunctionFields, composite PK,
 * no controller/DTOs/use-cases).
 *
 * Architecture-aware output paths: reads `generate.architecture` from
 * codegen.config.yaml and computes output paths for both 'clean' and
 * 'clean-lite-ps' pipelines. Relationship's prompt.js hardcodes clean-lite-ps
 * paths — this prompt does NOT inherit that limitation.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import pluralizePkg from "pluralize";

// ============================================================================
// Naming Helpers (inlined to avoid import issues with Hygen)
// ============================================================================

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const camelCase = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const pascalCase = (s) => capitalize(camelCase(s));
const pluralize = (s) => pluralizePkg.plural(s);
const kebabCase = (s) => s.replace(/_/g, "-");

// ============================================================================
// Config Loading Helpers
// ============================================================================

/**
 * Find and load codegen.config.yaml from cwd upward. Returns null when absent
 * (safe fallback: assume clean-lite-ps layout with srcRoot = 'src').
 */
function loadCodegenConfig(cwd) {
  const candidates = [
    path.join(cwd, "codegen.config.yaml"),
    path.join(cwd, "codegen.config.yml"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return yaml.parse(fs.readFileSync(p, "utf-8"));
      } catch {
        // Fall through
      }
    }
  }
  return null;
}

function resolveArchitecture(config) {
  return config?.generate?.architecture === "clean" ? "clean" : "clean-lite-ps";
}

function resolveSrcRoot(config, architecture) {
  // paths.backend_src from config; fallback by architecture
  const fromConfig = config?.paths?.backend_src;
  if (typeof fromConfig === "string" && fromConfig.length > 0) return fromConfig;
  return architecture === "clean" ? "app/backend/src" : "src";
}

// ============================================================================
// Name Derivation
// ============================================================================

function deriveJunctionName(config) {
  // Q8 resolution: insertion order — between: [opportunity, contact] → opportunity_contact
  // Explicit `name:` on the YAML overrides the derivation.
  return config.name ?? `${config.between[0]}_${config.between[1]}`;
}

function deriveTableName(config, junctionName) {
  return config.table ?? pluralize(junctionName);
}

// ============================================================================
// On-Delete Action Mapping
// ============================================================================

const ON_DELETE_MAP = {
  restrict: "restrict",
  cascade: "cascade",
  set_null: "set null",
  no_action: "no action",
};

// ============================================================================
// Drizzle Import Set
// ============================================================================

function buildDrizzleImports(hasRole, temporal, sourced, hasCustomFields, processedCustomFields) {
  const needed = new Set(["pgTable", "primaryKey", "uuid", "timestamp", "boolean", "numeric", "text"]);

  if (hasRole) needed.add("pgEnum");
  if (temporal) {
    // started_at / ended_at already covered by "timestamp" above
  }
  if (sourced) {
    // sourced_from: text, confidence: numeric, matched_at: timestamp — already in set
  }
  if (hasCustomFields) {
    for (const f of processedCustomFields) {
      if (f.hasChoices) needed.add("pgEnum");
      if (f.drizzleType && f.drizzleType !== "text" && f.drizzleType !== "timestamp") {
        needed.add(f.drizzleType);
      }
    }
  }

  // relations() is needed for the extension-path const
  needed.add("relations");

  return Array.from(needed).sort();
}

// ============================================================================
// Custom Field Processing
// ============================================================================

const DRIZZLE_TYPE_MAP = {
  string: "text",
  integer: "integer",
  decimal: "numeric",
  boolean: "boolean",
  uuid: "uuid",
  date: "date",
  datetime: "timestamp",
  json: "jsonb",
  enum: "text", // overridden below when hasChoices
};

function processCustomFields(fields, junctionName) {
  const processed = [];
  for (const [fieldName, field] of Object.entries(fields ?? {})) {
    const type = field.type || "string";
    const choices = field.choices;
    const hasChoices = Array.isArray(choices) && choices.length > 0;
    const drizzleType = hasChoices ? "text" : (DRIZZLE_TYPE_MAP[type] ?? "text");
    const enumName = hasChoices ? `${camelCase(junctionName)}${pascalCase(fieldName)}Enum` : null;

    processed.push({
      name: fieldName,
      camelName: camelCase(fieldName),
      type,
      drizzleType,
      nullable: field.nullable ?? true,
      required: field.required ?? false,
      choices: choices ?? [],
      hasChoices,
      enumName,
    });
  }
  return processed;
}

// ============================================================================
// Output Path Resolution (architecture-aware)
// ============================================================================

function resolveOutputPaths(name, plural, architecture, srcRoot) {
  if (architecture === "clean-lite-ps") {
    const prefix = srcRoot && srcRoot !== "." ? `${srcRoot}/` : "";
    return {
      entity:     `${prefix}modules/${plural}/${name}.entity.ts`,
      repository: `${prefix}modules/${plural}/${name}.repository.ts`,
      service:    `${prefix}modules/${plural}/${name}.service.ts`,
      module:     `${prefix}modules/${plural}/${plural}.module.ts`,
      index:      `${prefix}modules/${plural}/index.ts`,
    };
  }

  // 'clean' — full Clean Architecture. Mirrors entityFilePaths() in barrel-generator.ts.
  const pluralKebab = kebabCase(plural);
  return {
    entity:     `${srcRoot}/domain/${plural}/${name}.entity.ts`,
    repository: `${srcRoot}/infrastructure/persistence/drizzle/${pluralKebab}.repository.ts`,
    service:    `${srcRoot}/application/${plural}/${name}.service.ts`,
    module:     `${srcRoot}/infrastructure/modules/${pluralKebab}.module.ts`,
    index:      `${srcRoot}/domain/${plural}/index.ts`,
  };
}

// ============================================================================
// Main Export
// ============================================================================

export default {
  prompt: async ({ args }) => {
    const yamlPath = args.yaml;
    if (!yamlPath) {
      throw new Error(
        "Missing --yaml argument. Usage: bunx hygen junction new --yaml junctions/opportunity_contact.yaml"
      );
    }

    // Load and parse junction YAML
    const cwd = process.cwd();
    const fullPath = path.resolve(cwd, yamlPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const definition = yaml.parse(content);

    if (definition.pattern !== "Junction") {
      throw new Error(
        `Not a junction definition — expected top-level 'pattern: Junction' in ${yamlPath}. ` +
        `Got: pattern=${definition.pattern ?? "(missing)"}`
      );
    }

    const config = definition;
    const fields = definition.fields ?? {};

    // Warn if queries: block present (v1 ignores it — Q2 resolution)
    if (definition.queries && Array.isArray(definition.queries) && definition.queries.length > 0) {
      console.warn(
        `[junction/new] WARNING: 'queries:' block in ${yamlPath} is ignored in v1. ` +
        "Declarative queries on junctions land in a future leaf."
      );
    }

    // ======================================================================
    // Derive junction identity
    // ======================================================================

    const junctionName = deriveJunctionName(config);
    const tableName = deriveTableName(config, junctionName);
    const entityNamePascal = pascalCase(junctionName);
    const entityNameCamel = camelCase(junctionName);
    const entityNamePlural = tableName;
    const tableVarName = camelCase(entityNamePlural);
    const entityNamePluralPascal = pascalCase(entityNamePlural);
    const entityNameKebab = kebabCase(junctionName);
    const entityNamePluralKebab = kebabCase(entityNamePlural);

    // ======================================================================
    // Pairing endpoints
    // ======================================================================

    const leftEntity = config.between[0];   // e.g. 'opportunity'
    const rightEntity = config.between[1];  // e.g. 'contact'
    const leftEntityPascal = pascalCase(leftEntity);
    const rightEntityPascal = pascalCase(rightEntity);
    const leftEntityPlural = pluralize(leftEntity);
    const rightEntityPlural = pluralize(rightEntity);

    // FK column names (same derivation as relationship — no self-referential
    // prefix needed since between[] endpoints must be distinct per schema)
    const leftColumn = `${leftEntity}_id`;
    const rightColumn = `${rightEntity}_id`;
    const leftColumnCamel = camelCase(leftColumn);
    const rightColumnCamel = camelCase(rightColumn);

    // Drizzle variable names for the parent tables (used in FK .references())
    const leftTable = leftEntityPlural;   // e.g. 'opportunities'
    const rightTable = rightEntityPlural; // e.g. 'contacts'

    // ======================================================================
    // Role enum
    // ======================================================================

    const roleField = fields.role;
    const roleChoices = roleField?.choices;
    const hasRole = Array.isArray(roleChoices) && roleChoices.length > 0;
    const roleEnumName = hasRole ? `${entityNameCamel}RoleEnum` : null;
    const roleEnumValues = hasRole ? roleChoices : [];

    // ======================================================================
    // BaseJunctionFields gating (opt-outs per Q4 / #58 resolution)
    // ======================================================================

    const temporal = config.temporal !== false; // default true
    const sourced = config.sourced !== false;   // default true

    // ======================================================================
    // On-delete actions
    // ======================================================================

    const onDeleteLeftRaw = config.on_delete_left ?? "restrict";
    const onDeleteRightRaw = config.on_delete_right ?? "restrict";
    const onDeleteLeft = ON_DELETE_MAP[onDeleteLeftRaw] ?? "restrict";
    const onDeleteRight = ON_DELETE_MAP[onDeleteRightRaw] ?? "restrict";

    // ======================================================================
    // Custom fields (fields other than `role`)
    // ======================================================================

    const otherFields = { ...fields };
    delete otherFields.role; // role is handled separately as the role enum
    const processedCustomFields = processCustomFields(otherFields, junctionName);
    const hasCustomFields = processedCustomFields.length > 0;

    // ======================================================================
    // Drizzle imports
    // ======================================================================

    const drizzleImports = buildDrizzleImports(
      hasRole, temporal, sourced, hasCustomFields, processedCustomFields
    );

    // ======================================================================
    // Architecture-aware output paths
    // ======================================================================

    const config_ = loadCodegenConfig(cwd);
    const architecture = resolveArchitecture(config_);
    const srcRoot = resolveSrcRoot(config_, architecture);
    const outputPaths = resolveOutputPaths(junctionName, entityNamePlural, architecture, srcRoot);

    // ======================================================================
    // Class names
    // ======================================================================

    const classNames = {
      entity:     entityNamePascal,                    // OpportunityContact
      repository: `${entityNamePascal}Repository`,     // OpportunityContactRepository
      service:    `${entityNamePascal}Service`,        // OpportunityContactService
      module:     `${entityNamePluralPascal}Module`,   // OpportunityContactsModule
    };

    // ======================================================================
    // Return all template locals
    // ======================================================================

    return {
      // Identity
      name: junctionName,
      entityNamePascal,
      entityNameCamel,
      entityNamePlural,
      entityNamePluralPascal,
      entityNameKebab,
      entityNamePluralKebab,
      tableName,
      tableVarName,

      // Pairing endpoints
      between: config.between,
      leftEntity,
      rightEntity,
      leftEntityPascal,
      rightEntityPascal,
      leftEntityPlural,
      rightEntityPlural,
      leftColumn,
      rightColumn,
      leftColumnCamel,
      rightColumnCamel,
      selfReferential: false, // always false per schema refinement (endpoints must be distinct)

      // Role enum
      hasRole,
      roleEnumName,
      roleEnumValues,

      // BaseJunctionFields gating
      temporal,
      sourced,

      // On-delete
      onDeleteLeft,
      onDeleteRight,

      // Custom fields
      processedCustomFields,
      hasCustomFields,

      // Drizzle
      drizzleImports,

      // Output paths
      outputPaths,

      // Class names
      classNames,

      // Source root + architecture
      srcRoot,
      architecture,

      // Parent table Drizzle var names (for FK .references())
      leftTable,
      rightTable,
    };
  },
};
