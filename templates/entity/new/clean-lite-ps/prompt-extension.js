/**
 * Clean-Lite-PS template locals extension
 *
 * Exports buildCleanLitePsLocals(definition, baseLocals) which derives
 * all variables required by the clean-lite-ps template set.
 */

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
const pluralize = (s) => {
  if (s.endsWith('y')) return s.slice(0, -1) + 'ies';
  if (s.endsWith('s') || s.endsWith('x') || s.endsWith('ch') || s.endsWith('sh'))
    return s + 'es';
  return s + 's';
};

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
  // PG numeric is returned by Drizzle as a string; z.coerce.number() parses
  // strings at the boundary while still accepting numeric JSON input.
  decimal: 'z.coerce.number()',
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
  decimal: 'number',
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

  let chain = `${drizzleType}('${fieldName}')`;

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
function processBelongsTo(relationships) {
  if (!relationships) return [];

  const result = [];

  for (const [relName, rel] of Object.entries(relationships)) {
    if (rel.type !== 'belongs_to') continue;

    const target = rel.target;
    const field = rel.foreign_key;
    const nullable = rel.nullable ?? true;
    const relatedPlural = pluralize(target);

    result.push({
      field,
      camelField: camelCase(field),
      relatedEntity: target,
      relatedEntityPascal: pascalCase(target),
      relatedTable: relatedPlural,
      relatedPlural,
      nullable,
      importPath: `../${relatedPlural}/${target}.entity`,
    });
  }

  return result;
}

/**
 * Collect drizzle imports needed for entity fields
 */
function collectDrizzleImports(processedFields, belongsTo, hasTimestamps, hasSoftDelete) {
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

  // Family resolution
  const family = entity.family || 'base';
  const familyConfig = FAMILY_MAP[family] || FAMILY_MAP['base'];

  // Process entity fields
  const processedFields = processFields(fields);

  // Behavior flags (re-read from behaviors array for clean-lite-ps use)
  const behaviorNames = behaviors.map((b) => (typeof b === 'string' ? b : b.name));
  const hasTimestamps = behaviorNames.includes('timestamps');
  const hasSoftDelete = behaviorNames.includes('soft_delete');

  // Process declarative queries
  const processedQueries = processQueries(queriesBlock, processedFields, entityNamePascal);
  const hasDeclarativeQueries = processedQueries.length > 0;
  const declarativeQueryClasses = processedQueries.map((q) => q.useCaseClassName);
  const hasMultiFieldQuery = processedQueries.some((q) => q.hasMultipleParams);
  const hasOrderedQuery = processedQueries.some((q) => q.hasOrder);
  const hasViaQuery = processedQueries.some((q) => q.hasVia);

  // Process belongs_to relationships
  const belongsTo = processBelongsTo(relationships);

  // Filter FK fields that are already emitted by the clpBelongsTo loop
  const fkFieldNames = new Set(belongsTo.map((r) => r.field));
  const nonFkFields = processedFields.filter((f) => !fkFieldNames.has(f.name));

  // Drizzle imports needed
  const drizzleEntityImports = collectDrizzleImports(processedFields, belongsTo, hasTimestamps, hasSoftDelete);
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
    createDto: `Create${entityNamePascal}Dto`,
    updateDto: `Update${entityNamePascal}Dto`,
    outputDto: `${entityNamePascal}OutputDto`,
    createSchema: `Create${entityNamePascal}Schema`,
    updateSchema: `Update${entityNamePascal}Schema`,
    outputSchema: `${entityNamePascal}OutputSchema`,
  };

  // Fields for create DTO: exclude id, behavior-managed fields, and FK fields
  const createDtoFields = nonFkFields.filter(
    (f) => !BEHAVIOR_MANAGED_FIELDS.has(f.name),
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

  // Build zodChain for each output DTO field (all non-FK fields)
  const outputDtoFields = nonFkFields.map((f) => ({
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
