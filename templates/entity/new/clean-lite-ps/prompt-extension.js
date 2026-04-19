/**
 * Clean-Lite-PS template locals extension
 *
 * Exports buildCleanLitePsLocals(definition, baseLocals) which derives
 * all variables required by the clean-lite-ps template set.
 */

import pluralizePkg from 'pluralize';

// ============================================================================
// Family → Base Class Mapping
// ============================================================================

const FAMILY_MAP = {
  'synced': {
    repositoryBaseClass: 'SyncedEntityRepository',
    serviceBaseClass: 'SyncedEntityService',
    repositoryBaseImport: '@shared/base-classes/synced-entity-repository',
    serviceBaseImport: '@shared/base-classes/synced-entity-service',
    repositoryInheritedMethods: [
      'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
      'findByExternalId, findAllByUserId, findVisibleByUserId, syncUpsert',
    ],
    serviceInheritedMethods: [
      'findById, findByIds, list, count, exists, create, update, delete',
      'findByExternalId, findAllByUserId, findVisibleByUserId',
    ],
  },
  activity: {
    repositoryBaseClass: 'ActivityEntityRepository',
    serviceBaseClass: 'ActivityEntityService',
    repositoryBaseImport: '@shared/base-classes/activity-entity-repository',
    serviceBaseImport: '@shared/base-classes/activity-entity-service',
    repositoryInheritedMethods: [
      'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
      'findByDateRange, findByUserId, findByOpportunityId, findRecentByOpportunityId',
    ],
    serviceInheritedMethods: [
      'findById, findByIds, list, count, exists, create, update, delete',
      'findByDateRange, findByUserId, findByOpportunityId, findRecentByOpportunityId',
    ],
  },
  knowledge: {
    repositoryBaseClass: 'KnowledgeEntityRepository',
    serviceBaseClass: 'KnowledgeEntityService',
    repositoryBaseImport: '@shared/base-classes/knowledge-entity-repository',
    serviceBaseImport: '@shared/base-classes/knowledge-entity-service',
    repositoryInheritedMethods: [
      'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
      'semanticSearch, findPendingByOpportunityId, updateStatus, updateStatusBatch',
    ],
    serviceInheritedMethods: [
      'findById, findByIds, list, count, exists, create, update, delete',
      'semanticSearch, findPendingByOpportunityId, updateStatus, updateStatusBatch',
    ],
  },
  metadata: {
    repositoryBaseClass: 'MetadataEntityRepository',
    serviceBaseClass: 'MetadataEntityService',
    repositoryBaseImport: '@shared/base-classes/metadata-entity-repository',
    serviceBaseImport: '@shared/base-classes/metadata-entity-service',
    repositoryInheritedMethods: [
      'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
      'findByEntityIdAndType, listByEntityId, listHistoryByEntityId',
    ],
    serviceInheritedMethods: [
      'findById, findByIds, list, count, exists, create, update, delete',
      'findByEntityIdAndType, listByEntityId, listHistoryByEntityId',
    ],
  },
  base: {
    repositoryBaseClass: 'BaseRepository',
    serviceBaseClass: 'BaseService',
    repositoryBaseImport: '@shared/base-classes/base-repository',
    serviceBaseImport: '@shared/base-classes/base-service',
    repositoryInheritedMethods: [
      'findById, findByIds, list, count, exists, create, update, delete, upsertMany',
    ],
    serviceInheritedMethods: [
      'findById, findByIds, list, count, exists, create, update, delete',
    ],
  },
};

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
function buildDrizzleChain(fieldName, field, drizzleType) {
  const nullable = field.nullable ?? false;
  const required = field.required ?? false;
  const hasDefault = field.default !== undefined && field.default !== null;

  // Drizzle's `date('x')` returns the PgDateString builder by default
  // (data type: string). Force the Date-typed variant so DTO Zod
  // schemas using z.coerce.date() align with the entity type.
  // `timestamp` already defaults to Date — no mode override needed.
  let chain;
  if (drizzleType === 'date') {
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

    const drizzleType = DRIZZLE_TYPE_MAP[type] || 'text';
    const tsType = hasChoices
      ? choices.map((c) => `'${c}'`).join(' | ')
      : (TS_TYPE_MAP[type] || 'unknown');
    const zodType = hasChoices
      ? `z.enum([${choices.map((c) => `'${c}'`).join(', ')}])`
      : (ZOD_TYPE_MAP[type] || 'z.unknown()');

    const drizzleChain = buildDrizzleChain(fieldName, field, drizzleType);

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
    });
  }

  return processed;
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
    });
  }

  return result;
}

/**
 * Collect drizzle imports needed for entity fields
 */
function collectDrizzleImports(processedFields, belongsTo, hasTimestamps, hasSoftDelete, hasExternalIdTracking) {
  const imports = new Set(['pgTable', 'uuid']);

  for (const field of processedFields) {
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

  // external_id_tracking behavior injects varchar + jsonb columns
  if (hasExternalIdTracking) {
    imports.add('varchar');
    imports.add('jsonb');
  }

  if (belongsTo.length > 0) {
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

  // Family resolution
  const family = entity.family || 'base';
  const familyConfig = FAMILY_MAP[family] || FAMILY_MAP['base'];

  // Process entity fields
  const processedFields = processFields(fields);

  // Behavior flags (re-read from behaviors array for clean-lite-ps use)
  const behaviorNames = behaviors.map((b) => (typeof b === 'string' ? b : b.name));
  const hasTimestamps = behaviorNames.includes('timestamps');
  const hasSoftDelete = behaviorNames.includes('soft_delete');
  const hasExternalIdTracking = behaviorNames.includes('external_id_tracking');

  // Process declarative queries
  const processedQueries = processQueries(queriesBlock, processedFields, entityNamePascal);
  const hasDeclarativeQueries = processedQueries.length > 0;
  const declarativeQueryClasses = processedQueries.map((q) => q.useCaseClassName);
  const hasMultiFieldQuery = processedQueries.some((q) => q.hasMultipleParams);
  const hasOrderedQuery = processedQueries.some((q) => q.hasOrder);
  const hasViaQuery = processedQueries.some((q) => q.hasVia);

  // Process belongs_to relationships
  const belongsTo = processBelongsTo(relationships, entityNamePlural);

  // Filter FK fields that are already emitted by the clpBelongsTo loop
  const fkFieldNames = new Set(belongsTo.map((r) => r.field));
  const nonFkFields = processedFields.filter((f) => !fkFieldNames.has(f.name));

  // Drizzle imports needed
  const drizzleEntityImports = collectDrizzleImports(processedFields, belongsTo, hasTimestamps, hasSoftDelete, hasExternalIdTracking);
  // Whether relations() import is needed
  const hasRelationsBlock = belongsTo.length > 0;

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
    declarativeQueries: hasDeclarativeQueries
      ? `${srcRoot}/modules/${entityNamePlural}/use-cases/declarative-queries.ts`
      : null,
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

  return {
    // Clean-Lite-PS identity
    entityName,
    entityNamePascal,
    entityNamePlural,
    entityNamePluralPascal,

    // Family
    family,
    ...familyConfig,

    // Behavior flags (also exposed at top level for template use)
    hasTimestamps,
    hasSoftDelete,
    hasExternalIdTracking,

    // Generation toggles
    generateWrites,

    // EAV (ADR-13)
    eavEnabled,

    // Output paths
    clpOutputPaths: outputPaths,

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

    // Declarative queries
    processedQueries,
    hasDeclarativeQueries,
    declarativeQueryClasses,
    hasMultiFieldQuery,
    hasOrderedQuery,
    hasViaQuery,
  };
}
