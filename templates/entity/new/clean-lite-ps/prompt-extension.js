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
  'crm-synced': {
    repositoryBaseClass: 'CrmEntityRepository',
    serviceBaseClass: 'CrmEntityService',
    repositoryBaseImport: '@shared/base-classes/crm-entity-repository',
    serviceBaseImport: '@shared/base-classes/crm-entity-service',
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
  decimal: 'z.number()',
  boolean: 'z.boolean()',
  uuid: 'z.string().uuid()',
  date: 'z.coerce.date()',
  datetime: 'z.coerce.date()',
  json: 'z.record(z.unknown())',
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

  // Process belongs_to relationships
  const belongsTo = processBelongsTo(relationships);

  // Drizzle imports needed
  const drizzleEntityImports = collectDrizzleImports(processedFields, belongsTo, hasTimestamps, hasSoftDelete);
  // Whether relations() import is needed
  const hasRelationsBlock = belongsTo.length > 0;

  // Output paths
  const outputPaths = {
    entity: `modules/${entityNamePlural}/${entityName}.entity.ts`,
    repository: `modules/${entityNamePlural}/${entityName}.repository.ts`,
    service: `modules/${entityNamePlural}/${entityName}.service.ts`,
    controller: `modules/${entityNamePlural}/${entityName}.controller.ts`,
    module: `modules/${entityNamePlural}/${entityNamePlural}.module.ts`,
    findByIdUseCase: `modules/${entityNamePlural}/use-cases/find-${entityName}-by-id.use-case.ts`,
    listUseCase: `modules/${entityNamePlural}/use-cases/list-${entityNamePlural}.use-case.ts`,
    createDto: `modules/${entityNamePlural}/dto/create-${entityName}.dto.ts`,
    updateDto: `modules/${entityNamePlural}/dto/update-${entityName}.dto.ts`,
    outputDto: `modules/${entityNamePlural}/dto/${entityName}-output.dto.ts`,
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

  // Fields for create DTO: exclude id and behavior-managed fields
  const createDtoFields = processedFields.filter(
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

  // Build zodChain for each output DTO field (all fields including id)
  const outputDtoFields = processedFields.map((f) => ({
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
    clpProcessedFields: processedFields,
    clpCreateDtoFields: createDtoFieldsWithZod,
    clpOutputDtoFields: outputDtoFields,
    clpBelongsTo: belongsTo,
    clpBelongsToFkFields: belongsToFkFields,

    // Drizzle
    clpDrizzleImports: drizzleEntityImports,
    clpHasRelationsBlock: hasRelationsBlock,
  };
}
