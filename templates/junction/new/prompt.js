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
import { renderGeneratedBanner } from "../../_shared/generated-banner.mjs";

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
    // CGP-60 — parent-side paths + fan-out locals
    // ======================================================================
    // Parent service / module file paths — anchored on each endpoint.
    // The parent's own `entity new` pipeline previously wrote these files
    // with `force: true`; the junction inject templates target them.
    const leftParentPaths = resolveOutputPaths(leftEntity, leftEntityPlural, architecture, srcRoot);
    const rightParentPaths = resolveOutputPaths(rightEntity, rightEntityPlural, architecture, srcRoot);
    const parentServicePathLeft = leftParentPaths.service;
    const parentServicePathRight = rightParentPaths.service;
    const parentModulePathLeft = leftParentPaths.module;
    const parentModulePathRight = rightParentPaths.module;

    // Opt-out — defaults to { left: true, right: true }. Schema fills the
    // defaults when omitted, but tolerate raw YAML that bypasses Zod
    // (e.g. tests / direct Hygen invocation).
    const exposeRaw = config.expose_on_parent ?? {};
    const exposeOnParent = {
      left: exposeRaw.left !== false,   // default true
      right: exposeRaw.right !== false, // default true
    };

    // Per-junction unique inject markers (Risk (a) in spec — generic
    // markers silently skip second-junction emission on the same parent).
    const injectionMarkerLeft = `// junction:${junctionName}:left-fan-out`;
    const injectionMarkerRight = `// junction:${junctionName}:right-fan-out`;

    // Import path for the junction service from each parent's perspective.
    // clean-lite-ps layout: parent service lives at
    // `src/modules/<parentPlural>/<parent>.service.ts`; junction service at
    // `src/modules/<junctionPlural>/<junction>.service.ts`. Relative import
    // is `../<junctionPlural>/<junction>.service`.
    // 'clean' layout: parents live under application/<plural>, junction
    // under application/<junctionPlural>. Same `../` relative form works.
    const junctionServiceImportFromLeft = `../${entityNamePlural}/${junctionName}.service`;
    const junctionServiceImportFromRight = `../${entityNamePlural}/${junctionName}.service`;
    const junctionModuleImportFromLeft = `../${entityNamePlural}/${entityNamePlural}.module`;
    const junctionModuleImportFromRight = `../${entityNamePlural}/${entityNamePlural}.module`;

    // Left/right repo + module import paths from the junction service's
    // perspective (used by service.ejs.t to import target repos and by
    // module.ejs.t to import the parent modules).
    const leftRepoImportFromJunction = `../${leftEntityPlural}/${leftEntity}.repository`;
    const rightRepoImportFromJunction = `../${rightEntityPlural}/${rightEntity}.repository`;
    const leftEntityImportFromJunction = `../${leftEntityPlural}/${leftEntity}.entity`;
    const rightEntityImportFromJunction = `../${rightEntityPlural}/${rightEntity}.entity`;
    const leftModuleImportFromJunction = `../${leftEntityPlural}/${leftEntityPlural}.module`;
    const rightModuleImportFromJunction = `../${rightEntityPlural}/${rightEntityPlural}.module`;

    // Parent module / service class names + repo class names.
    const leftRepositoryClass = `${leftEntityPascal}Repository`;
    const rightRepositoryClass = `${rightEntityPascal}Repository`;
    const leftModuleClass = `${pascalCase(leftEntityPlural)}Module`;
    const rightModuleClass = `${pascalCase(rightEntityPlural)}Module`;
    const leftServiceClass = `${leftEntityPascal}Service`;
    const rightServiceClass = `${rightEntityPascal}Service`;

    // Camel forms of left/right entity names for use in method signatures
    // (e.g. attachContact -> opportunityId, contactId).
    const leftEntityCamel = camelCase(leftEntity);
    const rightEntityCamel = camelCase(rightEntity);

    // ======================================================================
    // Inbound-sync write surface (#374)
    // ======================================================================
    // The junction sync identity is the tuple (leftId, rightId[, role]); its
    // externalId is a COMPOSITE string. Both parent FKs resolve strictly. FK
    // write-keys use `${camelCase(entity)}ExternalId` (matches the reference).

    const leftSyncWriteKey = `${leftEntityCamel}ExternalId`;
    const rightSyncWriteKey = `${rightEntityCamel}ExternalId`;
    const roleColumnCamel = hasRole ? 'role' : null;
    // Role TS type — literal union from the enum choices, else absent.
    const roleTsType = hasRole
      ? roleChoices.map((c) => `'${c}'`).join(' | ')
      : null;

    // JunctionSyncConfig literal fields. refTable is emitted as a live table
    // identifier (leftTable/rightTable) by the template.
    const syncConfig = {
      leftColumn: leftColumnCamel,
      leftRefTable: leftTable,
      rightColumn: rightColumnCamel,
      rightRefTable: rightTable,
      roleColumn: roleColumnCamel,
    };

    // TSyncWrite fields: both parent external ids + optional role + userId.
    const syncWriteFields = [
      { name: leftSyncWriteKey, tsType: 'string' },
      { name: rightSyncWriteKey, tsType: 'string' },
      ...(hasRole ? [{ name: 'role', tsType: roleTsType }] : []),
      { name: 'userId', tsType: 'string' },
    ];

    // TSyncProjection fields: composite id + local FK columns + optional role +
    // timestamps. No surrogate id column on a junction.
    const syncProjectionFields = [
      { name: 'id', tsType: 'string' },
      { name: leftColumnCamel, tsType: 'string' },
      { name: rightColumnCamel, tsType: 'string' },
      ...(hasRole ? [{ name: 'role', tsType: roleTsType }] : []),
      { name: 'createdAt', tsType: 'Date' },
      { name: 'updatedAt', tsType: 'Date' },
    ];

    // Parent-table imports for the FK resolvers, deduped (#368). Junction
    // endpoints are distinct by schema, so two imports unless they collide.
    const syncParentImports = [];
    const seenSyncImports = new Set();
    for (const imp of [
      { table: leftTable, importPath: leftEntityImportFromJunction },
      { table: rightTable, importPath: rightEntityImportFromJunction },
    ]) {
      if (seenSyncImports.has(imp.table)) continue;
      seenSyncImports.add(imp.table);
      syncParentImports.push(imp);
    }

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

    // @generated DO-NOT-EDIT banner — stamped at the top of every
    // force-overwritten junction output. `yamlPath` is the consumer-relative
    // source definition.
    const generatedBanner = renderGeneratedBanner({
      // Relative to cwd so the banner is portable across machines.
      source: path.relative(cwd, fullPath),
      generator: 'junction',
      seam: 'the junction YAML',
    });

    return {
      // @generated DO-NOT-EDIT banner (see renderGeneratedBanner)
      generatedBanner,

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

      // ──────────────────────────────────────────────────────────────────
      // Inbound-sync write surface (#374)
      // ──────────────────────────────────────────────────────────────────
      leftSyncWriteKey,
      rightSyncWriteKey,
      roleColumnCamel,
      roleTsType,
      junctionSyncConfig: syncConfig,
      syncWriteFields,
      syncProjectionFields,
      syncParentImports,

      // ──────────────────────────────────────────────────────────────────
      // CGP-60 — fan-out locals
      // ──────────────────────────────────────────────────────────────────
      // Camel-case forms of endpoint names (used in method param names).
      leftEntityCamel,
      rightEntityCamel,
      // Parent service / module target paths for inject templates.
      parentServicePathLeft,
      parentServicePathRight,
      parentModulePathLeft,
      parentModulePathRight,
      // Opt-out toggles (default { left: true, right: true }).
      exposeOnParent,
      // Per-junction unique inject markers (skip_if idempotency).
      injectionMarkerLeft,
      injectionMarkerRight,
      // Junction service import paths from each parent's perspective.
      junctionServiceImportFromLeft,
      junctionServiceImportFromRight,
      junctionModuleImportFromLeft,
      junctionModuleImportFromRight,
      // Parent-side repo + entity + module import paths from the junction's
      // perspective (used by junction service.ejs.t + module.ejs.t).
      leftRepoImportFromJunction,
      rightRepoImportFromJunction,
      leftEntityImportFromJunction,
      rightEntityImportFromJunction,
      leftModuleImportFromJunction,
      rightModuleImportFromJunction,
      // Class names used by the inject + service + module templates.
      leftRepositoryClass,
      rightRepositoryClass,
      leftModuleClass,
      rightModuleClass,
      leftServiceClass,
      rightServiceClass,
    };
  },
};
