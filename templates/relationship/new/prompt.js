/**
 * Hygen prompt.js — Loads relationship YAML and prepares template locals
 *
 * Usage: bunx hygen relationship new --yaml relationships/person_organization.yaml
 *
 * Mirrors the structure of templates/entity/new/prompt.js but adapted for
 * first-class relationship definitions (junction tables with auto-generated
 * FK columns, type enum, temporal/sourced fields).
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
// Relationship FK Derivation (mirrors relationship-definition.schema.ts)
// ============================================================================

function deriveRelationshipFKColumns(config) {
  if (config.from === config.to) {
    return {
      fromColumn: `from_${config.from}_id`,
      toColumn: `to_${config.to}_id`,
    };
  }
  return {
    fromColumn: `${config.from}_id`,
    toColumn: `${config.to}_id`,
  };
}

function deriveTableName(config) {
  return config.table ?? pluralize(config.name);
}

function collectTypeNames(types) {
  if (!types) return [];
  if (Array.isArray(types)) return types;
  return Object.keys(types);
}

function deriveUniqueConstraint(config) {
  if (config.unique_on) return config.unique_on;

  const { fromColumn, toColumn } = deriveRelationshipFKColumns(config);
  const columns = [fromColumn, toColumn];

  if (config.types) {
    columns.push("type");
  }
  if (config.temporal && config.types) {
    columns.push("valid_from");
  }

  return columns;
}

function getReservedColumnNames(config) {
  const { fromColumn, toColumn } = deriveRelationshipFKColumns(config);
  const reserved = new Set(["id", "created_at", "updated_at", fromColumn, toColumn]);

  if (config.types) reserved.add("type");
  if (config.temporal !== false) {
    reserved.add("valid_from");
    reserved.add("valid_to");
    reserved.add("is_current");
  }
  if (config.sourced !== false) {
    reserved.add("source");
    reserved.add("confidence");
  }

  return reserved;
}

// ============================================================================
// Drizzle Type Maps
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
  string_array: "text",
};

const DRIZZLE_IMPORT_MAP = {
  text: "text",
  integer: "integer",
  numeric: "numeric",
  boolean: "boolean",
  uuid: "uuid",
  date: "date",
  timestamp: "timestamp",
  jsonb: "jsonb",
};

const ZOD_TYPE_MAP = {
  string: "z.string()",
  integer: "z.number().int()",
  decimal: "z.number()",
  boolean: "z.boolean()",
  uuid: "z.string().uuid()",
  date: "z.coerce.date()",
  datetime: "z.coerce.date()",
  json: "z.record(z.unknown())",
};

const TS_TYPE_MAP = {
  string: "string",
  integer: "number",
  decimal: "number",
  boolean: "boolean",
  uuid: "string",
  date: "Date",
  datetime: "Date",
  json: "unknown",
};

// ============================================================================
// Field Processing
// ============================================================================

function buildDrizzleChain(fieldName, field, drizzleType) {
  const nullable = field.nullable ?? false;
  const required = field.required ?? false;
  const hasDefault = field.default !== undefined && field.default !== null;

  let chain = `${drizzleType}('${fieldName}')`;
  if (required && !nullable) chain += ".notNull()";
  if (drizzleType === "boolean" && hasDefault) chain += `.default(${field.default})`;

  return chain;
}

function processFields(fields) {
  const processed = [];

  for (const [fieldName, field] of Object.entries(fields)) {
    if (fieldName === "id") continue;

    const type = field.type || "string";
    const nullable = field.nullable ?? false;
    const required = field.required ?? false;
    const hasDefault = field.default !== undefined && field.default !== null;
    const choices = field.choices;
    const hasChoices = Array.isArray(choices) && choices.length > 0;

    const drizzleType = DRIZZLE_TYPE_MAP[type] || "text";
    const tsType = hasChoices
      ? choices.map((c) => `'${c}'`).join(" | ")
      : TS_TYPE_MAP[type] || "unknown";
    const zodType = hasChoices
      ? `z.enum([${choices.map((c) => `'${c}'`).join(", ")}])`
      : ZOD_TYPE_MAP[type] || "z.unknown()";

    const drizzleChain = buildDrizzleChain(fieldName, field, drizzleType);
    const enumName = hasChoices ? camelCase(fieldName) + "Enum" : null;

    processed.push({
      name: fieldName,
      camelName: camelCase(fieldName),
      type,
      drizzleType,
      zodType,
      tsType,
      nullable,
      required,
      hasDefault,
      isPrimaryKey: false,
      drizzleChain,
      choices,
      hasChoices,
      enumName,
      foreignKey: field.foreign_key,
    });
  }

  return processed;
}

// ============================================================================
// Zod chain helpers for DTOs
// ============================================================================

function zodChainForCreate(field) {
  const { type, nullable, required, hasDefault, hasChoices, choices } = field;

  if (hasChoices) {
    const base = `z.enum([${choices.map((c) => `'${c}'`).join(", ")}])`;
    if (!required && !nullable) return base + ".optional()";
    if (nullable) return base + ".nullable()";
    return base;
  }

  let base = ZOD_TYPE_MAP[type] || "z.unknown()";
  if (type === "boolean" && hasDefault) {
    base += `.default(${field.default ?? false})`;
    return base;
  }
  if (nullable) return base + ".nullable()";
  if (!required) return base + ".optional()";
  return base;
}

function zodChainForOutput(field) {
  const { type, nullable, hasChoices, choices } = field;

  if (hasChoices) {
    const base = `z.enum([${choices.map((c) => `'${c}'`).join(", ")}])`;
    if (nullable) return base + ".nullable()";
    return base;
  }

  let base = ZOD_TYPE_MAP[type] || "z.unknown()";
  if (nullable) return base + ".nullable()";
  return base;
}

// ============================================================================
// Query Processing
// ============================================================================

function deriveQueryMethodName(query) {
  const byFields = Array.isArray(query.by) ? query.by : [];
  const selectFields = Array.isArray(query.select) ? query.select : [];

  const byPart = byFields.map((f) => pascalCase(f)).join("And");

  if (selectFields.length > 0) {
    const selectPart = selectFields.map((f) => pascalCase(f)).join("And") + "s";
    return `find${selectPart}By${byPart}`;
  }

  return `findBy${byPart}`;
}

function processQueries(queriesBlock, allFieldsMap, entityNamePascal) {
  if (!queriesBlock || !Array.isArray(queriesBlock) || queriesBlock.length === 0) {
    return [];
  }

  return queriesBlock.map((q) => {
    const byFields = Array.isArray(q.by) ? q.by : [];
    const selectFields = Array.isArray(q.select) ? q.select : [];
    const isUnique = q.unique ?? false;

    const params = byFields.map((f) => ({
      name: f,
      camelName: camelCase(f),
      tsType: allFieldsMap[f] || allFieldsMap[camelCase(f)] || "string",
    }));

    let orderBy = null;
    let orderDirection = null;
    if (q.order) {
      const parts = q.order.trim().split(/\s+/);
      orderBy = camelCase(parts[0]);
      orderDirection = parts[1] || "asc";
    }

    const methodName = deriveQueryMethodName(q);

    let returnType;
    if (isUnique) {
      returnType = `${entityNamePascal} | null`;
    } else if (selectFields.length > 0) {
      const camelFields = selectFields.map((f) => camelCase(f));
      returnType =
        selectFields.length === 1
          ? `${allFieldsMap[selectFields[0]] || allFieldsMap[camelFields[0]] || "string"}[]`
          : `Pick<${entityNamePascal}, ${camelFields.map((f) => `'${f}'`).join(" | ")}>[]`;
    } else {
      returnType = `${entityNamePascal}[]`;
    }

    const methodPascal = pascalCase(methodName);
    const useCaseClassName =
      methodPascal.replace(/^Find/, `Find${entityNamePascal}`) + "UseCase";

    return {
      by: byFields,
      unique: isUnique,
      select: selectFields,
      order: q.order ?? null,
      limit: q.limit ?? null,
      methodName,
      returnType,
      params,
      isUnique,
      orderBy,
      orderDirection,
      selectFields: selectFields.map((f) => camelCase(f)),
      useCaseClassName,
      hasSelect: selectFields.length > 0,
      hasOrder: q.order != null,
      hasLimit: q.limit != null,
      hasMultipleParams: params.length > 1,
    };
  });
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
// Main Export
// ============================================================================

export default {
  prompt: async ({ args }) => {
    const yamlPath = args.yaml;
    if (!yamlPath) {
      throw new Error(
        "Missing --yaml argument. Usage: bunx hygen relationship new --yaml relationships/person_organization.yaml"
      );
    }

    // Load and parse YAML
    const fullPath = path.resolve(process.cwd(), yamlPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const definition = yaml.parse(content);

    if (!definition.relationship) {
      throw new Error(
        `Not a relationship definition — expected top-level 'relationship:' key in ${yamlPath}`
      );
    }

    const config = definition.relationship;
    const fields = definition.fields || {};
    const queriesBlock = definition.queries || null;

    // ======================================================================
    // Derive auto-generated metadata
    // ======================================================================

    const { fromColumn, toColumn } = deriveRelationshipFKColumns(config);
    const tableName = deriveTableName(config);
    const uniqueOn = deriveUniqueConstraint(config);
    const typeNames = collectTypeNames(config.types);
    const hasTypes = typeNames.length > 0;
    const selfReferential = config.from === config.to;
    const temporal = config.temporal !== false; // default true
    const sourced = config.sourced !== false; // default true

    // On-delete actions
    const onDeleteFrom = config.on_delete_from ?? "restrict";
    const onDeleteTo = config.on_delete_to ?? "restrict";
    const onDeleteFromSql = ON_DELETE_MAP[onDeleteFrom] || "restrict";
    const onDeleteToSql = ON_DELETE_MAP[onDeleteTo] || "restrict";

    // ======================================================================
    // Name variations
    // ======================================================================

    const name = config.name; // person_organization
    const entityNamePascal = pascalCase(name); // PersonOrganization
    const entityNameCamel = camelCase(name); // personOrganization
    const entityNamePlural = tableName; // person_organizations
    const tableVarName = camelCase(entityNamePlural); // personOrganizations
    const entityNamePluralPascal = pascalCase(entityNamePlural); // PersonOrganizations
    const entityNameKebab = kebabCase(name); // person-organization
    const entityNamePluralKebab = kebabCase(entityNamePlural); // person-organizations

    // From/to entity name variations
    const fromEntityPascal = pascalCase(config.from);
    const toEntityPascal = pascalCase(config.to);
    const fromEntityPlural = pluralize(config.from);
    const toEntityPlural = pluralize(config.to);
    const fromColumnCamel = camelCase(fromColumn);
    const toColumnCamel = camelCase(toColumn);

    // ======================================================================
    // Process custom fields
    // ======================================================================

    const processedFields = processFields(fields);
    const enumFields = processedFields.filter((f) => f.hasChoices);

    // Build a lookup of ALL fields (auto-generated + custom) for query resolution
    const allFieldsTypeMap = {};

    // Auto-generated FK fields
    allFieldsTypeMap[fromColumn] = "string";
    allFieldsTypeMap[fromColumnCamel] = "string";
    allFieldsTypeMap[toColumn] = "string";
    allFieldsTypeMap[toColumnCamel] = "string";

    // Type field
    if (hasTypes) {
      const typeUnion = typeNames.map((t) => `'${t}'`).join(" | ");
      allFieldsTypeMap["type"] = typeUnion;
    }

    // Temporal fields
    if (temporal) {
      allFieldsTypeMap["valid_from"] = "Date";
      allFieldsTypeMap["validFrom"] = "Date";
      allFieldsTypeMap["valid_to"] = "Date";
      allFieldsTypeMap["validTo"] = "Date";
      allFieldsTypeMap["is_current"] = "boolean";
      allFieldsTypeMap["isCurrent"] = "boolean";
    }

    // Sourced fields
    if (sourced) {
      allFieldsTypeMap["source"] = "string";
      allFieldsTypeMap["confidence"] = "number";
    }

    // Custom fields
    for (const pf of processedFields) {
      allFieldsTypeMap[pf.name] = pf.tsType;
      allFieldsTypeMap[pf.camelName] = pf.tsType;
    }

    // ======================================================================
    // Process declarative queries
    // ======================================================================

    const processedQueries = processQueries(
      queriesBlock,
      allFieldsTypeMap,
      entityNamePascal
    );
    const hasDeclarativeQueries = processedQueries.length > 0;
    const declarativeQueryClasses = processedQueries.map((q) => q.useCaseClassName);
    const hasMultiFieldQuery = processedQueries.some((q) => q.hasMultipleParams);
    const hasOrderedQuery = processedQueries.some((q) => q.hasOrder);

    // ======================================================================
    // Drizzle imports
    // ======================================================================

    const drizzleImportsNeeded = new Set(["pgTable", "uuid"]);

    // FK columns need uuid
    drizzleImportsNeeded.add("uuid");

    // Type enum
    if (hasTypes) {
      drizzleImportsNeeded.add("pgEnum");
    }

    // Custom field enums
    if (enumFields.length > 0) {
      drizzleImportsNeeded.add("pgEnum");
    }

    // Sourced — source is also an enum
    if (sourced) {
      drizzleImportsNeeded.add("pgEnum");
    }

    // Temporal fields
    if (temporal) {
      drizzleImportsNeeded.add("date");
      drizzleImportsNeeded.add("boolean");
    }

    // Sourced fields
    if (sourced) {
      drizzleImportsNeeded.add("numeric");
    }

    // Timestamps (always present on relationships)
    drizzleImportsNeeded.add("timestamp");

    // Custom field types
    for (const field of processedFields) {
      const importName = DRIZZLE_IMPORT_MAP[field.drizzleType];
      if (importName) drizzleImportsNeeded.add(importName);
    }

    // Unique constraint
    drizzleImportsNeeded.add("uniqueIndex");

    const drizzleImports = Array.from(drizzleImportsNeeded).sort();

    // ======================================================================
    // Zod chains for DTO fields
    // ======================================================================

    const createDtoFields = processedFields.map((f) => ({
      ...f,
      zodChainCreate: zodChainForCreate(f),
    }));

    const outputDtoFields = processedFields.map((f) => ({
      ...f,
      zodChainOutput: zodChainForOutput(f),
    }));

    // ======================================================================
    // Source root — default to 'src'
    // ======================================================================

    const srcRoot = "src";

    // ======================================================================
    // Output paths (mirrors clean-lite-ps layout)
    // ======================================================================

    const outputPaths = {
      entity: `${srcRoot}/modules/${entityNamePlural}/${name}.entity.ts`,
      repository: `${srcRoot}/modules/${entityNamePlural}/${name}.repository.ts`,
      service: `${srcRoot}/modules/${entityNamePlural}/${name}.service.ts`,
      controller: `${srcRoot}/modules/${entityNamePlural}/${name}.controller.ts`,
      module: `${srcRoot}/modules/${entityNamePlural}/${entityNamePlural}.module.ts`,
      createDto: `${srcRoot}/modules/${entityNamePlural}/dto/create-${name}.dto.ts`,
      updateDto: `${srcRoot}/modules/${entityNamePlural}/dto/update-${name}.dto.ts`,
      outputDto: `${srcRoot}/modules/${entityNamePlural}/dto/${name}-output.dto.ts`,
      index: `${srcRoot}/modules/${entityNamePlural}/index.ts`,
      findByIdUseCase: `${srcRoot}/modules/${entityNamePlural}/use-cases/find-${name}-by-id.use-case.ts`,
      listUseCase: `${srcRoot}/modules/${entityNamePlural}/use-cases/list-${entityNamePlural}.use-case.ts`,
      declarativeQueries: hasDeclarativeQueries
        ? `${srcRoot}/modules/${entityNamePlural}/use-cases/declarative-queries.ts`
        : null,
    };

    // ======================================================================
    // Class names
    // ======================================================================

    const classNames = {
      entity: entityNamePascal,
      entityTable: entityNamePlural,
      repository: `${entityNamePascal}Repository`,
      service: `${entityNamePascal}Service`,
      controller: `${entityNamePascal}Controller`,
      module: `${entityNamePluralPascal}Module`,
      findByIdUseCase: `Find${entityNamePascal}ByIdUseCase`,
      listUseCase: `List${entityNamePluralPascal}UseCase`,
      createDto: `Create${entityNamePascal}Dto`,
      updateDto: `Update${entityNamePascal}Dto`,
      outputDto: `${entityNamePascal}OutputDto`,
      createSchema: `Create${entityNamePascal}Schema`,
      updateSchema: `Update${entityNamePascal}Schema`,
      outputSchema: `${entityNamePascal}OutputSchema`,
    };

    // ======================================================================
    // Unique constraint columns with camelCase names
    // ======================================================================

    const uniqueOnCamel = uniqueOn.map((col) => camelCase(col));

    // ======================================================================
    // Type enum details
    // ======================================================================

    const typeEnumName = hasTypes ? `${entityNameCamel}TypeEnum` : null;
    const typeEnumValues = typeNames;

    // Source enum (if sourced)
    const sourceEnumName = sourced ? `${entityNameCamel}SourceEnum` : null;
    const sourceEnumValues = sourced
      ? ["manual", "system", "import", "integration", "ai"]
      : [];

    // ======================================================================
    // Return all template locals
    // ======================================================================

    return {
      // Identity
      name,
      entityNamePascal,
      entityNameCamel,
      entityNamePlural,
      entityNamePluralPascal,
      entityNameKebab,
      entityNamePluralKebab,
      tableName,
      tableVarName,

      // Relationship config
      from: config.from,
      to: config.to,
      fromEntityPascal,
      toEntityPascal,
      fromEntityPlural,
      toEntityPlural,
      selfReferential,

      // FK columns
      fromColumn,
      toColumn,
      fromColumnCamel,
      toColumnCamel,

      // Type taxonomy
      hasTypes,
      typeNames,
      typeEnumName,
      typeEnumValues,

      // Behavioral flags
      temporal,
      sourced,

      // On-delete
      onDeleteFrom,
      onDeleteTo,
      onDeleteFromSql,
      onDeleteToSql,

      // Unique constraint
      uniqueOn,
      uniqueOnCamel,

      // Source tracking
      sourceEnumName,
      sourceEnumValues,

      // Custom fields
      processedFields,
      enumFields,
      hasCustomFields: processedFields.length > 0,

      // DTO fields
      createDtoFields,
      outputDtoFields,

      // Declarative queries
      processedQueries,
      hasDeclarativeQueries,
      declarativeQueryClasses,
      hasMultiFieldQuery,
      hasOrderedQuery,

      // Drizzle
      drizzleImports,

      // Output paths
      outputPaths,

      // Class names
      classNames,

      // srcRoot
      srcRoot,

      // From entity table references (for FK .references())
      fromTable: fromEntityPlural,
      toTable: toEntityPlural,
    };
  },
};
