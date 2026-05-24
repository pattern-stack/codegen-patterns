/**
 * Clean-Lite-PS template locals extension
 *
 * Exports buildCleanLitePsLocals(definition, baseLocals) which derives
 * all variables required by the clean-lite-ps template set.
 */

import fs from 'node:fs';
import path from 'node:path';
import pluralizePkg from 'pluralize';
// The patterns barrel has the side effect of pre-registering the five
// library-shipped patterns (Base / Synced / Activity / Knowledge /
// Metadata). App-defined patterns are loaded separately in the parent
// prompt.js via loadAppPatterns() against `codegen.config.yaml patterns:`
// globs before this helper runs — we only read the registry here.
import { getPattern } from '../../../../src/patterns/registry.js';
import '../../../../src/patterns/library/index.js';

// ============================================================================
// Pattern registry resolution
// ============================================================================


/**
 * Serialize a plain object as an idiomatic TypeScript object literal.
 * Unlike JSON.stringify, this emits bare identifier keys when legal
 * (matching the ADR-031 §4 example) and single-quoted strings. Only
 * the shapes that actually appear in validated pattern configs are
 * supported — strings, numbers, booleans, nulls, nested objects, and
 * arrays of the same. Anything else falls through to JSON.stringify
 * to stay safe.
 */
function renderPatternConfigLiteral(value, indent = '  ', initialIndent = '') {
  // `currentIndent` is the indent applied to the closing brace of the
  // outermost value; nested lines add one more level of `indent`.
  // Templates that emit this helper inside an already-indented block
  // (e.g. a class body indented by 2 spaces) should pass the block's
  // indent as `initialIndent` so the closing brace and child lines line
  // up correctly with the surrounding code.
  return _renderLiteral(value, indent, initialIndent);
}

function _renderLiteral(value, baseIndent, currentIndent) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    // Single-quoted TS string with \\ + ' escapes. Matches ADR-031 example style.
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const next = currentIndent + baseIndent;
    const items = value.map((v) => `${next}${_renderLiteral(v, baseIndent, next)}`);
    return `[\n${items.join(',\n')},\n${currentIndent}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const next = currentIndent + baseIndent;
    const lines = entries.map(([k, v]) => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : `'${k}'`;
      return `${next}${key}: ${_renderLiteral(v, baseIndent, next)}`;
    });
    return `{\n${lines.join(',\n')},\n${currentIndent}}`;
  }
  // Anything else — fall back to a safe JSON serialization.
  return JSON.stringify(value);
}

/**
 * Resolve the base-class locals (repository + service class name + import
 * path + inherited-method comment lines) for an entity by looking up its
 * declared pattern in the shared registry.
 *
 * Resolution order:
 *   1. `entity.pattern` — single-pattern case. Returns that pattern's record.
 *   2. `entity.patterns[0]` — multi-pattern case: the first name drives the
 *      base-class choice. Subsequent patterns contribute columns + implied
 *      behaviors (PATTERN-4 composition check) but do not change the
 *      template's repository/service base class.
 *   3. `'Base'` fallback — library pattern that anchors the identity case.
 *
 * Exported for unit-testing; consumers import `buildCleanLitePsLocals`.
 */
export function resolvePatternBaseClasses(entity) {
  const name =
    (typeof entity.pattern === 'string' && entity.pattern) ||
    (Array.isArray(entity.patterns) && entity.patterns[0]) ||
    'Base';
  const def = getPattern(name) || getPattern('Base');
  if (!def) {
    throw new Error(
      `Pattern '${name}' is not registered, and the library 'Base' pattern ` +
      `is also missing. Did the patterns barrel fail to load?`,
    );
  }
  return {
    patternName: def.name,
    repositoryBaseClass: def.repositoryClass,
    serviceBaseClass: def.serviceClass,
    repositoryBaseImport: def.repositoryImport,
    serviceBaseImport: def.serviceImport,
    repositoryInheritedMethods: def.repositoryInheritedMethods ?? [],
    serviceInheritedMethods: def.serviceInheritedMethods ?? [],
  };
}

/**
 * Resolve the behaviors implied by an entity's declared pattern(s).
 *
 * A pattern (e.g. `Synced`) may declare `impliedBehaviors` — behaviors the
 * entity gets for free without re-declaring them in its `behaviors:` array.
 * Walks every declared pattern (both the `pattern: X` and `patterns: [...]`
 * shapes), unions their `impliedBehaviors`, and returns a deduped list.
 * Unknown patterns are skipped silently — composition validation surfaces
 * those separately (src/patterns/validate-composition.ts).
 *
 * @param {object} entity - the entity block from the parsed YAML
 * @returns {string[]} deduped implied behavior names
 */
export function resolveImpliedBehaviors(entity) {
  const names = [];
  if (typeof entity.pattern === 'string' && entity.pattern) {
    names.push(entity.pattern);
  }
  if (Array.isArray(entity.patterns)) {
    names.push(...entity.patterns);
  }

  const implied = new Set();
  for (const name of names) {
    const def = getPattern(name);
    for (const b of def?.impliedBehaviors ?? []) {
      implied.add(b);
    }
  }
  return Array.from(implied);
}

// ============================================================================
// Helper utilities
// ============================================================================

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const camelCase = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const pascalCase = (s) => capitalize(camelCase(s));
const pluralize = (s) => pluralizePkg.plural(s);

// ============================================================================
// Drizzle type mapping
// ============================================================================

const DRIZZLE_TYPE_MAP = {
  string: 'text',
  integer: 'integer',
  decimal: 'numeric',
  boolean: 'boolean',
  uuid: 'uuid',
  date: 'date',
  datetime: 'timestamp',
  json: 'jsonb',
};

// Drizzle import name for each drizzle type
const DRIZZLE_IMPORT_MAP = {
  text: 'text',
  integer: 'integer',
  numeric: 'numeric',
  boolean: 'boolean',
  uuid: 'uuid',
  date: 'date',
  timestamp: 'timestamp',
  jsonb: 'jsonb',
};

// ============================================================================
// Zod type mapping
// ============================================================================

const ZOD_TYPE_MAP = {
  string: 'z.string()',
  integer: 'z.number().int()',
  // PG numeric is returned by Drizzle as a string (precision preservation);
  // z.coerce.string() accepts either JSON string or number and coerces to string
  // so the DTO type aligns with the entity type. Do arithmetic at the consumer
  // via Number(value) or a BigNumber library.
  decimal: 'z.coerce.string()',
  boolean: 'z.boolean()',
  uuid: 'z.string().uuid()',
  date: 'z.coerce.date()',
  datetime: 'z.coerce.date()',
  // jsonb has no schema guarantees and routinely holds arrays, objects, or
  // scalars — z.unknown() preserves that. Use z.record(...) shaping in refine
  // code at the consumer if stricter validation is needed.
  json: 'z.unknown()',
};

// TypeScript type mapping
const TS_TYPE_MAP = {
  string: 'string',
  integer: 'number',
  decimal: 'string',
  boolean: 'boolean',
  uuid: 'string',
  date: 'Date',
  datetime: 'Date',
  json: 'unknown',
};

// Fields managed by behaviors — excluded from create DTO
const BEHAVIOR_MANAGED_FIELDS = new Set([
  'created_at',
  'updated_at',
  'deleted_at',
  'created_by',
  'updated_by',
  'valid_from',
  'valid_to',
  'is_active',
]);

// Fields injected by external_id_tracking behavior — only behavior-managed when
// that behavior is enabled (otherwise 'provider' etc. could be a legitimate
// user-declared field, e.g. on field_definition).
const EXTERNAL_ID_TRACKING_FIELDS = new Set([
  'external_id',
  'provider',
  'provider_metadata',
]);

// ============================================================================
// Field processors
// ============================================================================

/**
 * Build a Drizzle column chain for a field
 */
function buildDrizzleChain(fieldName, field, drizzleType, enumName) {
  const nullable = field.nullable ?? false;
  const required = field.required ?? false;
  const hasDefault = field.default !== undefined && field.default !== null;

  // Drizzle's `date('x')` returns the PgDateString builder by default
  // (data type: string). Force the Date-typed variant so DTO Zod
  // schemas using z.coerce.date() align with the entity type.
  // `timestamp` already defaults to Date — no mode override needed.
  let chain;
  if (drizzleType === 'enum' && enumName) {
    // Reference the pgEnum declaration emitted at the top of the entity file.
    // The column name argument keeps the snake_case YAML field name.
    chain = `${enumName}('${fieldName}')`;
  } else if (drizzleType === 'date') {
    chain = `${drizzleType}('${fieldName}', { mode: 'date' })`;
  } else {
    chain = `${drizzleType}('${fieldName}')`;
  }

  // Add .notNull() for non-nullable required fields
  if (required && !nullable) {
    chain += '.notNull()';
  }

  // Boolean defaults
  if (drizzleType === 'boolean' && hasDefault) {
    chain += `.default(${field.default})`;
  }

  // Timestamp defaults for datetime fields in behavior context handled separately
  return chain;
}

/**
 * Process entity fields into ProcessedField[]
 */
function processFields(fields) {
  const processed = [];

  for (const [fieldName, field] of Object.entries(fields)) {
    if (fieldName === 'id') continue;

    const type = field.type || 'string';
    const nullable = field.nullable ?? false;
    const required = field.required ?? false;
    const hasDefault = field.default !== undefined && field.default !== null;
    const choices = field.choices;
    const hasChoices = Array.isArray(choices) && choices.length > 0;

    // Enum-typed fields (or any field with a `choices` list) emit a
    // Postgres-native pgEnum declaration + column reference, so the
    // generated `InferSelectModel` type narrows to the literal union
    // instead of falling back to `string`. Matches the backend pipeline
    // (templates/entity/new/backend/database/schema.ejs.t:66-104).
    const drizzleType = hasChoices
      ? 'enum'
      : (DRIZZLE_TYPE_MAP[type] || 'text');
    const enumName = hasChoices ? camelCase(fieldName) + 'Enum' : null;
    const tsType = hasChoices
      ? choices.map((c) => `'${c}'`).join(' | ')
      : (TS_TYPE_MAP[type] || 'unknown');
    const zodType = hasChoices
      ? `z.enum([${choices.map((c) => `'${c}'`).join(', ')}])`
      : (ZOD_TYPE_MAP[type] || 'z.unknown()');

    const drizzleChain = buildDrizzleChain(fieldName, field, drizzleType, enumName);

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
    });
  }

  return processed;
}

/**
 * Map YAML on_delete value to the Drizzle onDelete option string.
 *
 * ADR-021 uses snake_case values in YAML (set_null, no_action) while
 * Drizzle expects the SQL keyword form with a space ('set null', 'no action').
 */
function mapOnDelete(onDelete) {
  const map = {
    restrict: 'restrict',
    cascade: 'cascade',
    set_null: 'set null',
    no_action: 'no action',
  };
  return map[onDelete] ?? 'restrict';
}

/**
 * Process has_many relationships into HasManyRelation[].
 *
 * Mirrors processBelongsTo. The `foreign_key` declared on a has_many
 * relationship is the inverse FK living on the *target* entity's table —
 * e.g. `account.relationships.contacts: { foreign_key: account_id }` means
 * contacts.account_id. The method name on AccountRepository would be
 * `findByAccountId`.
 */
function processHasMany(relationships, parentEntityNamePlural, fs, path, srcRoot) {
  if (!relationships) return [];

  const result = [];

  for (const [relName, rel] of Object.entries(relationships)) {
    if (rel.type !== 'has_many') continue;

    const target = rel.target;
    const inverseForeignKey = rel.foreign_key;
    const targetPlural = pluralize(target);
    const isSelfRef = targetPlural === parentEntityNamePlural;

    // Check whether the target entity has already been generated.
    // Only include targets that exist so the import block doesn't
    // reference files that aren't on disk yet (two-pass generation).
    let targetExists = false;
    if (fs && path && srcRoot) {
      const nestedPath = path.resolve(srcRoot, 'modules', targetPlural, `${target}.entity.ts`);
      const flatPath = path.resolve(srcRoot, 'modules', `${target}.entity.ts`);
      targetExists = fs.existsSync(nestedPath) || fs.existsSync(flatPath) || isSelfRef;
    } else {
      targetExists = isSelfRef;
    }

    result.push({
      name: relName,
      target,
      targetClass: pascalCase(target),
      targetPlural,
      inverseForeignKey,
      inverseForeignKeyCamel: camelCase(inverseForeignKey),
      inverseForeignKeyPascal: pascalCase(inverseForeignKey),
      isSelfRef,
      targetExists,
      importPath: `../${targetPlural}/${target}.repository`,
    });
  }

  return result;
}

/**
 * Process belongs_to relationships into BelongsToRelation[]
 */
function processBelongsTo(relationships, parentEntityNamePlural) {
  if (!relationships) return [];

  const result = [];

  for (const [relName, rel] of Object.entries(relationships)) {
    if (rel.type !== 'belongs_to') continue;

    const target = rel.target;
    const field = rel.foreign_key;
    const nullable = rel.nullable ?? true;
    const relatedPlural = pluralize(target);
    const isSelfFk = relatedPlural === parentEntityNamePlural;

    // on_delete defaults to 'restrict' per ADR-021
    const onDeleteYaml = rel.on_delete ?? 'restrict';
    const onDelete = mapOnDelete(onDeleteYaml);

    // Relation key: for self-FKs derive from the FK column name
    // (parent_account_id → parentAccount) to avoid colliding with the
    // table's own snake_case name. For non-self-FKs preserve the prior
    // behavior of using the target entity name verbatim so existing
    // consumer code (e.g. drizzle queryBuilder.with.field_definition)
    // keeps working.
    let relationKey;
    if (isSelfFk) {
      // parent_account_id → parent_account → parentAccount
      const base = field.endsWith('_id') ? field.slice(0, -3) : field;
      relationKey = camelCase(base);
    } else {
      relationKey = target;
    }

    result.push({
      field,
      camelField: camelCase(field),
      relatedEntity: target,
      relatedEntityPascal: pascalCase(target),
      relatedTable: relatedPlural,
      relatedPlural,
      nullable,
      importPath: `../${relatedPlural}/${target}.entity`,
      relationKey,
      isSelfFk,
      onDelete,
      onDeleteYaml,
    });
  }

  return result;
}

/**
 * Collect drizzle imports needed for entity fields
 */
function collectDrizzleImports(processedFields, belongsTo, hasTimestamps, hasSoftDelete, hasExternalIdTracking, hasMany = []) {
  const imports = new Set(['pgTable', 'uuid']);

  for (const field of processedFields) {
    if (field.drizzleType === 'enum') {
      // Enum columns reference a `pgEnum` declaration emitted at the top
      // of the entity file; the helper itself comes from drizzle-orm/pg-core.
      imports.add('pgEnum');
      continue;
    }
    const importName = DRIZZLE_IMPORT_MAP[field.drizzleType];
    if (importName) imports.add(importName);
  }

  // FK uuid columns from belongs_to
  if (belongsTo.length > 0) {
    imports.add('uuid');
  }

  // Behavior imports
  if (hasTimestamps || hasSoftDelete) {
    imports.add('timestamp');
  }

  // external_id_tracking behavior injects varchar + jsonb columns plus a
  // unique index over (provider, external_id) — the ON CONFLICT target the
  // sync sink's syncUpsert relies on.
  if (hasExternalIdTracking) {
    imports.add('varchar');
    imports.add('jsonb');
    imports.add('uniqueIndex');
  }

  if (belongsTo.length > 0 || hasMany.length > 0) {
    imports.add('relations');
  }

  return Array.from(imports).sort();
}

/**
 * Derive Zod chain for a field in create DTO context
 */
function zodChainForCreate(field) {
  const { type, nullable, required, hasDefault, hasChoices, choices } = field;

  if (hasChoices) {
    const base = `z.enum([${choices.map((c) => `'${c}'`).join(', ')}])`;
    if (!required && !nullable) return base + '.optional()';
    if (nullable) return base + '.nullable()';
    return base;
  }

  let base = ZOD_TYPE_MAP[type] || 'z.unknown()';

  if (type === 'boolean' && hasDefault) {
    base += `.default(${field.default ?? false})`;
    return base;
  }

  if (nullable) {
    return base + '.nullable()';
  }

  if (!required) {
    return base + '.optional()';
  }

  return base;
}

/**
 * Derive Zod chain for a field in output DTO context
 */
function zodChainForOutput(field) {
  const { type, nullable, hasChoices, choices } = field;

  if (hasChoices) {
    const base = `z.enum([${choices.map((c) => `'${c}'`).join(', ')}])`;
    if (nullable) return base + '.nullable()';
    return base;
  }

  let base = ZOD_TYPE_MAP[type] || 'z.unknown()';

  if (nullable) {
    return base + '.nullable()';
  }

  return base;
}

// ============================================================================
// Query processing
// ============================================================================

/**
 * Derive repository method name from a declarative query definition.
 * E.g., { by: ['user_id'] } → 'findByUserId'
 *       { by: ['email'], unique: true } → 'findByEmail'
 *       { by: ['opportunity_id'], select: ['email'] } → 'findEmailsByOpportunityId'
 */
function deriveQueryMethodName(query) {
  const byFields = Array.isArray(query.by) ? query.by : [];
  const selectFields = Array.isArray(query.select) ? query.select : [];

  const byPart = byFields.map((f) => pascalCase(f)).join('And');

  if (selectFields.length > 0) {
    const selectPart = selectFields.map((f) => pascalCase(f)).join('And') + 's';
    return `find${selectPart}By${byPart}`;
  }

  return `findBy${byPart}`;
}

/**
 * Process declarative queries from YAML queries: block.
 * Produces typed query metadata for template generation.
 */
function processQueries(queriesBlock, processedFields, entityNamePascal) {
  if (!queriesBlock || !Array.isArray(queriesBlock) || queriesBlock.length === 0) {
    return [];
  }

  // Build field name → TS type lookup
  const fieldTypeMap = {};
  for (const pf of processedFields) {
    fieldTypeMap[pf.name] = pf.tsType;
    fieldTypeMap[pf.camelName] = pf.tsType;
  }

  return queriesBlock.map((q) => {
    const byFields = Array.isArray(q.by) ? q.by : [];
    const selectFields = Array.isArray(q.select) ? q.select : [];
    const isUnique = q.unique ?? false;
    const viaTable = q.via ?? null;

    const params = byFields.map((f) => ({
      name: f,
      camelName: camelCase(f),
      tsType: fieldTypeMap[f] || fieldTypeMap[camelCase(f)] || 'string',
    }));

    let orderBy = null;
    let orderDirection = null;
    if (q.order) {
      const parts = q.order.trim().split(/\s+/);
      orderBy = camelCase(parts[0]);
      orderDirection = parts[1] || 'asc';
    }

    const methodName = deriveQueryMethodName(q);

    let returnType;
    if (isUnique) {
      returnType = `${entityNamePascal} | null`;
    } else if (selectFields.length > 0) {
      const camelFields = selectFields.map((f) => camelCase(f));
      returnType = selectFields.length === 1
        ? `${fieldTypeMap[selectFields[0]] || fieldTypeMap[camelFields[0]] || 'string'}[]`
        : `Pick<${entityNamePascal}, ${camelFields.map((f) => `'${f}'`).join(' | ')}>[]`;
    } else {
      returnType = `${entityNamePascal}[]`;
    }

    // Prefix class name with entity to guarantee uniqueness across modules.
    // e.g. methodName 'findByDomain' on Account → 'FindAccountByDomainUseCase'
    //      methodName 'findEmailsByOpportunityId' on Contact → 'FindContactEmailsByOpportunityIdUseCase'
    const methodPascal = pascalCase(methodName);
    const useCaseClassName = methodPascal.replace(/^Find/, `Find${entityNamePascal}`) + 'UseCase';

    return {
      by: byFields,
      unique: isUnique,
      select: selectFields,
      order: q.order ?? null,
      limit: q.limit ?? null,
      via: viaTable,
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
      hasVia: viaTable != null,
      hasSelect: selectFields.length > 0,
      hasOrder: q.order != null,
      hasLimit: q.limit != null,
      hasMultipleParams: params.length > 1,
    };
  });
}

// ============================================================================
// Search query processing
// ============================================================================

/**
 * Process the `queries: - name: search` declarations into template locals.
 *
 * A search query compiles down to:
 *   - A `SearchXsUseCase` class composing the entity service's list+count
 *     with filter-AND and optional ilike search.
 *   - A thin `@Get('search')` controller route that runs the request
 *     querystring through a Zod schema before delegating.
 *   - A `searchUseCase` / output-path entry so the module/controller
 *     templates can emit imports + provider entries.
 *
 * Multiple search declarations per entity aren't supported yet — first
 * one wins and a warning surfaces in the emitted comment. Consumers can
 * split into separate entities if they need multiple search surfaces.
 */
function processSearchQueries(queriesBlock, processedFields, belongsTo, entityName, entityNamePascal, entityNamePlural, entityNamePluralPascal) {
  if (!queriesBlock || !Array.isArray(queriesBlock)) return null;
  const search = queriesBlock.find((q) => q && q.name === 'search');
  if (!search) return null;

  const filters = Array.isArray(search.filters) ? search.filters : [];
  if (filters.length === 0) return null;

  // Build a field->type lookup that covers both regular fields and FK
  // columns from belongs_to relationships — filters commonly target
  // account_id / user_id etc.
  const fieldTypeMap = {};
  for (const pf of processedFields) {
    const entry = {
      tsType: pf.tsType,
      hasChoices: pf.hasChoices,
      choices: pf.choices,
      isUuid: pf.type === 'uuid',
    };
    fieldTypeMap[pf.name] = entry;
    fieldTypeMap[pf.camelName] = entry;
  }
  for (const rel of belongsTo) {
    fieldTypeMap[rel.field] = { tsType: 'string', isUuid: true };
    fieldTypeMap[rel.camelField] = { tsType: 'string', isUuid: true };
  }

  const resolvedFilters = filters.map((name) => {
    const info = fieldTypeMap[name] || fieldTypeMap[camelCase(name)] || { tsType: 'string' };
    return {
      name,
      camelName: camelCase(name),
      tsType: info.tsType,
      hasChoices: !!info.hasChoices,
      choices: info.choices,
      isUuid: !!info.isUuid,
      // Booleans + numbers need z.coerce.* in the querystring schema.
      isBoolean: info.tsType === 'boolean',
      isNumber: info.tsType === 'number',
    };
  });

  const searchField = typeof search.search === 'string' ? search.search : null;
  const paginate = search.paginate !== false; // default true

  return {
    filters: resolvedFilters,
    searchField,
    searchFieldCamel: searchField ? camelCase(searchField) : null,
    paginate,
    useCaseClassName: `Search${entityNamePluralPascal}UseCase`,
    filtersSchemaName: `${entityNamePascal}FiltersSchema`,
    inputTypeName: `Search${entityNamePluralPascal}Input`,
  };
}

// ============================================================================
// Main export
// ============================================================================

/**
 * Build Clean-Lite-PS template locals from entity definition and base locals
 *
 * @param {object} definition - Parsed entity YAML
 * @param {object} baseLocals - Locals from main prompt.js
 * @returns {object} Merged locals with all clean-lite-ps variables
 */
export function buildCleanLitePsLocals(definition, baseLocals) {
  const entity = definition.entity;
  const fields = definition.fields || {};
  const relationships = definition.relationships || {};
  const behaviors = definition.behaviors || [];
  const queriesBlock = definition.queries || null;

  // Source root — resolved in priority order:
  //   1. baseLocals.srcRoot (e.g. set explicitly by tests or callers)
  //   2. entity.src_root (per-entity override in YAML)
  //   3. baseLocals.backendSrc (clean-lite-ps reads paths.backend_src from
  //      codegen.config.yaml; prompt.js threads BASE_PATHS.backendSrc here)
  //   4. 'src' (sane default for greenfield projects)
  const srcRoot =
    baseLocals.srcRoot ||
    entity.src_root ||
    baseLocals.backendSrc ||
    'src';

  const entityName = entity.name;
  const entityNamePascal = pascalCase(entityName);
  const entityNamePlural = entity.plural || pluralize(entityName);
  const entityNamePluralPascal = pascalCase(entityNamePlural);

  // Generation toggles — `generate.writes` defaults to true so consumers who
  // regenerate pick up create/update/delete use cases without YAML changes.
  // Set `generate.writes: false` in YAML to suppress write-side emission
  // (use cases, controller routes, module providers).
  const generateBlock = definition.generate || {};
  const generateWrites = generateBlock.writes !== false;

  // EAV (ADR-13) — when true, emit paired reads + transactional compound
  // writes. Consumer must provide `@shared/eav-helpers` and `FieldValueService`.
  const eavEnabled = definition.eav === true;

  // EAV value-table shape (task #23) — when true, this entity IS the value
  // table. Templates emit compound methods (upsertFieldsTransactional,
  // findMergedByEntity) on the service, upsertCurrentValues on the repo,
  // and auto-wire the paired field-definitions module for DI.
  const eavValueTable = definition.eav_value_table === true;
  const eavDefinitionEntity = eavValueTable
    ? (definition.eav_definition_table || null)
    : null;
  const eavDefinitionEntityPlural = eavDefinitionEntity
    ? pluralize(eavDefinitionEntity)
    : null;
  const eavDefinitionPascal = eavDefinitionEntity
    ? pascalCase(eavDefinitionEntity)
    : null;
  const eavDefinitionPluralPascal = eavDefinitionEntityPlural
    ? pascalCase(eavDefinitionEntityPlural)
    : null;

  // Pattern resolution — registry-driven (ADR-031, PATTERN-5).
  //
  // The prior PATTERN-3 bridge that lowercased the pattern name to index
  // FAMILY_MAP is gone; the registry returns the canonical record. The
  // shape returned by `resolvePatternBaseClasses` matches the legacy
  // FAMILY_MAP entries verbatim for the five library patterns so the
  // emitted output is byte-identical.
  const patternBase = resolvePatternBaseClasses(entity);
  const { patternName } = patternBase;
  // FAMILY_MAP is gone (PATTERN-5); `patternConfigClasses` is the structural
  // equivalent — repository + service class names + import paths + inherited
  // method comment lists, sourced directly from the pattern registry.
  const patternConfigClasses = {
    repositoryBaseClass: patternBase.repositoryBaseClass,
    serviceBaseClass: patternBase.serviceBaseClass,
    repositoryBaseImport: patternBase.repositoryBaseImport,
    serviceBaseImport: patternBase.serviceBaseImport,
    repositoryInheritedMethods: patternBase.repositoryInheritedMethods,
    serviceInheritedMethods: patternBase.serviceInheritedMethods,
  };
  // Per-entity pattern config: resolve the matching block from
  // `config: { <PatternName>: {...} }`. When the pattern has no
  // configSchema OR the entity doesn't provide one, this stays null and
  // templates emit no `patternConfig` property.
  const patternConfigBlock =
    (definition.config && definition.config[patternName]) ||
    (definition.entity && definition.entity.config && definition.entity.config[patternName]) ||
    null;
  const hasPatternConfig =
    patternConfigBlock != null &&
    typeof patternConfigBlock === 'object' &&
    Object.keys(patternConfigBlock).length > 0;

  // Process entity fields
  const processedFields = processFields(fields);

  // Behavior flags (re-read from behaviors array for clean-lite-ps use).
  //
  // Fold in the resolved pattern's `impliedBehaviors` (ADR-031): an entity
  // declaring e.g. `pattern: Synced` need not re-declare the
  // `external_id_tracking` behavior — the pattern contributes it. Deduped
  // with any explicit `behaviors:` entries, explicit-first so order is
  // stable for pre-existing fixtures. Mirrors the dedup in
  // src/patterns/validate-composition.ts.
  const explicitBehaviorNames = behaviors.map((b) => (typeof b === 'string' ? b : b.name));
  const impliedBehaviorNames = resolveImpliedBehaviors(entity);
  const behaviorNames = [
    ...explicitBehaviorNames,
    ...impliedBehaviorNames.filter((b) => !explicitBehaviorNames.includes(b)),
  ];
  const hasTimestamps = behaviorNames.includes('timestamps');
  const hasSoftDelete = behaviorNames.includes('soft_delete');
  const hasUserTracking = behaviorNames.includes('user_tracking');
  const hasExternalIdTracking = behaviorNames.includes('external_id_tracking');

  // Process declarative queries
  // Filter out search-named entries — they're handled by
  // processSearchQueries below. processQueries only understands the
  // by-column shape.
  const byColumnQueries = Array.isArray(queriesBlock)
    ? queriesBlock.filter((q) => q && 'by' in q)
    : queriesBlock;
  const processedQueries = processQueries(byColumnQueries, processedFields, entityNamePascal);
  // Process search query declaration (at most one per entity for now).
  const searchQuery = processSearchQueries(
    queriesBlock,
    processedFields,
    [], // belongsTo populated below — late-bind via reassignment
    entityName,
    entityNamePascal,
    entityNamePlural,
    entityNamePluralPascal,
  );

  const hasDeclarativeQueries = processedQueries.length > 0;
  const declarativeQueryClasses = processedQueries.map((q) => q.useCaseClassName);
  const hasMultiFieldQuery = processedQueries.some((q) => q.hasMultipleParams);
  const hasOrderedQuery = processedQueries.some((q) => q.hasOrder);
  const hasViaQuery = processedQueries.some((q) => q.hasVia);

  // Process belongs_to relationships
  const belongsTo = processBelongsTo(relationships, entityNamePlural);

  // Process has_many relationships (CGP-358b)
  const hasMany = processHasMany(relationships, entityNamePlural, fs, path, srcRoot);

  // Issue #41 — warn when a soft-delete entity declares non-restrict on_delete on any
  // belongs_to relation. The FK constraint applies to hard-delete only;
  // developers expecting soft-delete cascade must use activeParentFilter() instead.
  if (hasSoftDelete && belongsTo.some((rel) => rel.onDeleteYaml !== 'restrict')) {
    const affectedRels = belongsTo
      .filter((rel) => rel.onDeleteYaml !== 'restrict')
      .map((rel) => `${rel.field} (on_delete: ${rel.onDeleteYaml})`)
      .join(', ');
    console.warn(
      `[codegen] WARNING: ${entityName} has soft_delete behavior but declares non-restrict on_delete on: ${affectedRels}. ` +
      `on_delete is a no-op for soft-delete — only hard-DELETE triggers Postgres cascade rules. ` +
      `See ADR-021: docs/adrs/ADR-021-on-delete-semantics.md`,
    );
  }

  // Re-process search query now that belongsTo is known — filters can
  // reference FK columns (account_id, user_id) which aren't in
  // processedFields because they're emitted by the belongsTo loop.
  const searchQueryResolved = processSearchQueries(
    queriesBlock,
    processedFields,
    belongsTo,
    entityName,
    entityNamePascal,
    entityNamePlural,
    entityNamePluralPascal,
  );


  // Filter FK fields that are already emitted by the clpBelongsTo loop
  const fkFieldNames = new Set(belongsTo.map((r) => r.field));
  const nonFkFields = processedFields.filter((f) => !fkFieldNames.has(f.name));

  // Enum field declarations — surface a separate collection so the entity
  // template can emit `export const xEnum = pgEnum('x', [...])` ahead of
  // the `pgTable(...)` block. Both FK-filtered and unfiltered processing
  // include the same enum fields; they're never FKs.
  const clpEnumFields = processedFields
    .filter((f) => f.hasChoices && f.enumName)
    .map((f) => ({
      enumName: f.enumName,
      dbName: f.name,
      choices: f.choices,
    }));

  // Drizzle imports needed
  const drizzleEntityImports = collectDrizzleImports(processedFields, belongsTo, hasTimestamps, hasSoftDelete, hasExternalIdTracking, hasMany);
  // Whether relations() import is needed (CGP-358b: also trigger on has_many)
  const hasRelationsBlock = belongsTo.length > 0 || hasMany.length > 0;

  // Output paths
  const outputPaths = {
    entity: `${srcRoot}/modules/${entityNamePlural}/${entityName}.entity.ts`,
    repository: `${srcRoot}/modules/${entityNamePlural}/${entityName}.repository.ts`,
    service: `${srcRoot}/modules/${entityNamePlural}/${entityName}.service.ts`,
    controller: `${srcRoot}/modules/${entityNamePlural}/${entityName}.controller.ts`,
    module: `${srcRoot}/modules/${entityNamePlural}/${entityNamePlural}.module.ts`,
    index: `${srcRoot}/modules/${entityNamePlural}/index.ts`,
    findByIdUseCase: `${srcRoot}/modules/${entityNamePlural}/use-cases/find-${entityName}-by-id.use-case.ts`,
    listUseCase: `${srcRoot}/modules/${entityNamePlural}/use-cases/list-${entityNamePlural}.use-case.ts`,
    findByIdWithFieldsUseCase: eavEnabled
      ? `${srcRoot}/modules/${entityNamePlural}/use-cases/find-${entityName}-by-id-with-fields.use-case.ts`
      : null,
    listWithFieldsUseCase: eavEnabled
      ? `${srcRoot}/modules/${entityNamePlural}/use-cases/list-${entityNamePlural}-with-fields.use-case.ts`
      : null,
    createUseCase: generateWrites
      ? `${srcRoot}/modules/${entityNamePlural}/use-cases/create-${entityName}.use-case.ts`
      : null,
    updateUseCase: generateWrites
      ? `${srcRoot}/modules/${entityNamePlural}/use-cases/update-${entityName}.use-case.ts`
      : null,
    deleteUseCase: generateWrites
      ? `${srcRoot}/modules/${entityNamePlural}/use-cases/delete-${entityName}.use-case.ts`
      : null,
    createDto: `${srcRoot}/modules/${entityNamePlural}/dto/create-${entityName}.dto.ts`,
    updateDto: `${srcRoot}/modules/${entityNamePlural}/dto/update-${entityName}.dto.ts`,
    outputDto: `${srcRoot}/modules/${entityNamePlural}/dto/${entityName}-output.dto.ts`,
    searchUseCase: searchQueryResolved
      ? `${srcRoot}/modules/${entityNamePlural}/use-cases/search-${entityNamePlural}.use-case.ts`
      : null,
    searchController: searchQueryResolved
      ? `${srcRoot}/modules/${entityNamePlural}/${entityName}-search.controller.ts`
      : null,
    declarativeQueries: hasDeclarativeQueries
      ? `${srcRoot}/modules/${entityNamePlural}/use-cases/declarative-queries.ts`
      : null,
    // ADR-033.1 §8 — sync-source module emission for clean-lite-ps. Co-located
    // with the entity feature module under src/modules/<plural>/. Closes #267.
    syncSourceModule: `${srcRoot}/modules/${entityNamePlural}/${entityName}-sync-source.module.ts`,
    syncSourceProviders: `${srcRoot}/modules/${entityNamePlural}/${entityName}-sync-source.providers.ts`,
  };

  // Architecture-specific imports for clean-lite-ps. The sync-source module
  // imports the entity type sibling-style (`./<entity>.entity`) since the
  // module file lives next to the entity file in the same feature folder.
  const clpImports = {
    syncSourceToEntity: `./${entityName}.entity`,
  };

  // Class names
  const classNames = {
    entity: entityNamePascal,
    entityTable: entityNamePlural,
    repository: `${entityNamePascal}Repository`,
    service: `${entityNamePascal}Service`,
    controller: `${entityNamePascal}Controller`,
    module: `${entityNamePluralPascal}Module`,
    findByIdUseCase: `Find${entityNamePascal}ByIdUseCase`,
    searchUseCase: `Search${entityNamePluralPascal}UseCase`,
    searchController: `${entityNamePascal}SearchController`,
    listUseCase: `List${entityNamePluralPascal}UseCase`,
    findByIdWithFieldsUseCase: `Find${entityNamePascal}ByIdWithFieldsUseCase`,
    listWithFieldsUseCase: `List${entityNamePluralPascal}WithFieldsUseCase`,
    createUseCase: `Create${entityNamePascal}UseCase`,
    updateUseCase: `Update${entityNamePascal}UseCase`,
    deleteUseCase: `Delete${entityNamePascal}UseCase`,
    createDto: `Create${entityNamePascal}Dto`,
    updateDto: `Update${entityNamePascal}Dto`,
    outputDto: `${entityNamePascal}OutputDto`,
    createSchema: `Create${entityNamePascal}Schema`,
    updateSchema: `Update${entityNamePascal}Schema`,
    outputSchema: `${entityNamePascal}OutputSchema`,
  };

  // Fields for create DTO: exclude id, behavior-managed fields, and FK fields
  const createDtoFields = nonFkFields.filter(
    (f) => !BEHAVIOR_MANAGED_FIELDS.has(f.name)
        && !(hasExternalIdTracking && EXTERNAL_ID_TRACKING_FIELDS.has(f.name)),
  );

  // FK fields from belongs_to for create/output DTOs
  const belongsToFkFields = belongsTo.map((rel) => ({
    camelName: rel.camelField,
    zodChainCreate: rel.nullable ? 'z.string().uuid().nullable()' : 'z.string().uuid()',
    zodChainOutput: rel.nullable ? 'z.string().uuid().nullable()' : 'z.string().uuid()',
    nullable: rel.nullable,
  }));

  // Build zodChain for each create DTO field
  const createDtoFieldsWithZod = createDtoFields.map((f) => ({
    ...f,
    zodChainCreate: zodChainForCreate(f),
  }));

  // Build zodChain for each output DTO field (all non-FK fields).
  // When external_id_tracking is enabled, its fields are injected into the
  // entity table but do not appear in the output DTO (they're metadata).
  const outputDtoSource = hasExternalIdTracking
    ? nonFkFields.filter((f) => !EXTERNAL_ID_TRACKING_FIELDS.has(f.name))
    : nonFkFields;
  const outputDtoFields = outputDtoSource.map((f) => ({
    ...f,
    zodChainOutput: zodChainForOutput(f),
  }));

  // EVT-7: emits locals flow through from baseLocals (prompt.js computed them
  // against the full events registry). When this helper is called in isolation
  // (e.g. from unit tests) baseLocals.hasEmits may be undefined — provide
  // null-safe defaults so the CLP templates emits guards evaluate to false
  // cleanly.
  const hasEmits = Boolean(baseLocals?.hasEmits);
  const emitsEvents = baseLocals?.emitsEvents ?? [];
  const createEventType = baseLocals?.createEventType ?? null;
  const updateEventType = baseLocals?.updateEventType ?? null;
  const deleteEventType = baseLocals?.deleteEventType ?? null;
  const eventsTokenImport =
    baseLocals?.eventsTokenImport ?? '@shared/subsystems/events';
  const typedEventBusImport =
    baseLocals?.typedEventBusImport ?? '@shared/subsystems/events';
  const drizzleTokenImport =
    baseLocals?.drizzleTokenImport ?? '@shared/constants/tokens';
  const drizzleTypeImport =
    baseLocals?.drizzleTypeImport ?? '@shared/types/drizzle';

  return {
    // Clean-Lite-PS identity
    entityName,
    entityNamePascal,
    entityNamePlural,
    entityNamePluralPascal,

    // EVT-7 emits locals (null-safe defaults if baseLocals didn't provide them)
    hasEmits,
    emitsEvents,
    createEventType,
    updateEventType,
    deleteEventType,
    eventsTokenImport,
    typedEventBusImport,
    drizzleTokenImport,
    drizzleTypeImport,

    // Pattern — registry-driven (ADR-031)
    patternName,
    hasPatternConfig,
    patternConfig: patternConfigBlock,
    renderPatternConfigLiteral,
    ...patternConfigClasses,

    // Behavior flags (also exposed at top level for template use)
    hasTimestamps,
    hasSoftDelete,
    hasUserTracking,
    hasExternalIdTracking,

    // Generation toggles
    generateWrites,

    // EAV (ADR-13)
    eavEnabled,

    // EAV value-table (task #23) — this entity IS the value table.
    eavValueTable,
    eavDefinitionEntity,
    eavDefinitionEntityPlural,
    eavDefinitionPascal,
    eavDefinitionPluralPascal,
    // Search query (#16)
    searchQuery: searchQueryResolved,
    hasSearchQuery: !!searchQueryResolved,


    // Output paths
    clpOutputPaths: outputPaths,

    // Architecture-specific imports (ADR-033.1 §8 — sync-source closes #267)
    clpImports,

    // Class names
    classNames,

    // Field data
    clpProcessedFields: nonFkFields,
    clpCreateDtoFields: createDtoFieldsWithZod,
    clpOutputDtoFields: outputDtoFields,
    clpBelongsTo: belongsTo,
    clpBelongsToFkFields: belongsToFkFields,

    // Drizzle
    clpDrizzleImports: drizzleEntityImports,
    clpHasRelationsBlock: hasRelationsBlock,
    // A self-referential belongs_to FK requires the `references()` callback
    // to carry a `: AnyPgColumn` return-type annotation; otherwise TypeScript's
    // strict mode flags the table const with TS7022/TS7024 (circular initializer).
    // Surfaced by the cgp-62 relationship-scenario smoke when generating a CRM
    // account with a `parent_account_id` self-FK.
    clpHasSelfFk: belongsTo.some((rel) => rel.isSelfFk),
    clpEnumFields,

    // Declarative queries
    processedQueries,
    hasDeclarativeQueries,
    declarativeQueryClasses,
    hasMultiFieldQuery,
    hasOrderedQuery,
    hasViaQuery,

    // CGP-358b: has_many relationships for service-layer composition
    clpHasMany: hasMany,
    clpHasManyRelations: hasMany.length > 0,
    clpExistingHasMany: hasMany.filter((r) => r.targetExists),
  };
}
