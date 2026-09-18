/**
 * Clean-Lite-PS template locals extension
 *
 * Exports buildCleanLitePsLocals(definition, baseLocals) which derives
 * all variables required by the clean-lite-ps template set.
 */

import fs from 'node:fs';
import path from 'node:path';
import pluralizePkg from 'pluralize';
import yaml from 'yaml';
// The patterns barrel has the side effect of pre-registering the five
// library-shipped patterns (Base / Integrated / Activity / Knowledge /
// Metadata). App-defined patterns are loaded separately in the parent
// prompt.js via loadAppPatterns() against `codegen.config.yaml patterns:`
// globs before this helper runs — we only read the registry here.
import { getPattern } from '../../../../src/patterns/registry.js';
import {
  composePatterns,
  declaredPatternNames,
  detectMethodCollisions,
} from '../../../../src/patterns/compose.js';
import '../../../../src/patterns/library/index.js';
import { rewriteSharedImport } from '../../../../src/config/runtime-mode.mjs';
import {
  ACTOR_CAPABILITY,
  COMMUNICATION_CAPABILITY,
} from '../../../../src/roles/derive.js';

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

/**
 * A config value that is a TypeScript identifier rather than a string — a
 * Drizzle table handle a library capability's resolved config carries
 * (`via: { table: meetingContacts }`, ADR-041.1). `_renderLiteral` writes it
 * bare; the resolver that produced it also returns the import.
 *
 * The marker is a module-private Symbol key, so no value parsed from YAML (an
 * app capability's verbatim `config:`) can ever be mistaken for one.
 */
const IDENTIFIER_REF = Symbol('codegen.identifierRef');

export function identifierRef(name) {
  return { [IDENTIFIER_REF]: name };
}

function isIdentifierRef(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value[IDENTIFIER_REF] === 'string'
  );
}

/**
 * An entity's module naming, from its OWN `entity:` block — the rule its own
 * emission uses (`buildCleanLitePsLocals`), so a cross-entity reference and the
 * referenced entity agree by construction: `plural:` (else `pluralize(name)`)
 * is both the table export and the module folder, nested under `context:`.
 */
export function entityModuleNaming(entityBlock, srcRoot) {
  const plural = entityBlock.plural || pluralize(entityBlock.name);
  const groupDir = entityBlock.context
    ? `${srcRoot}/modules/${entityBlock.context}`
    : `${srcRoot}/modules`;
  return {
    plural,
    moduleGroupDir: groupDir,
    entityFile: `${groupDir}/${plural}/${entityBlock.name}.entity`,
  };
}

/**
 * Look up another entity's `entity:` block by name from the project's entity
 * YAMLs (`<cwd>/<paths.entities_dir | 'entities'>`, the frontend emitter's
 * rule). Lazy and cached: the directory is read only when a cross-entity
 * reference needs a fact the referencing YAML does not state (ADR-041.1: a
 * group Actor's member entity). Parsed with `yaml` directly, as `prompt.js`
 * parses every entity — the zod-backed registry does not ship to consumers.
 *
 * Exported for unit-testing; `prompt.js` passes one as `entityLookup`.
 */
export function createEntityLookup(entitiesDir) {
  let byName = null;
  const load = () => {
    byName = new Map();
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.ya?ml$/.test(e.name)) {
          try {
            const doc = yaml.parse(fs.readFileSync(full, 'utf-8'));
            if (doc && doc.entity && typeof doc.entity.name === 'string') {
              byName.set(doc.entity.name, doc.entity);
            }
          } catch {
            // A malformed YAML is reported by the CLI's own validation; it is
            // simply not resolvable here.
          }
        }
      }
    };
    walk(entitiesDir);
  };
  return (name) => {
    if (!byName) load();
    return byName.get(name) ?? null;
  };
}

function _renderLiteral(value, baseIndent, currentIndent) {
  if (value === null) return 'null';
  if (isIdentifierRef(value)) return value[IDENTIFIER_REF];
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
 * Resolve a library capability's repository config (ADR-041.1, CAP-3).
 *
 * CAP-1's hand-off renders a capability's `config:` block verbatim. The two
 * library capabilities need more: their mixins read Drizzle tables and column
 * keys, and the YAML names neither — it names roles, junctions and has_many
 * relationships. This resolves those names, once, at generation:
 *
 *   - `Communication` → `{ roles: { <role>: edge } }` from the `roles:` block.
 *     A one-role's column is its `clpBelongsTo` entry's `camelField` — the FK
 *     CAP-2 already derived, not a second derivation. A many-role's junction is
 *     addressed by `junction new`'s naming rules (table
 *     `camelCase(pluralize(via))`, file `modules/<plural>/<via>.entity`, FK
 *     columns `<entity>_id`), which have no YAML override.
 *   - `Actor` → `{ kind }`, plus for a group the member table + FK of the
 *     `has_many` that `members:` names.
 *
 * Returns `null` for any other capability (its config stays verbatim), else
 * `{ config, imports }`. Throws — a generation error, ADR-041 §4's posture — on
 * a missing or invalid `Actor` config, a `members:` that is not a has_many, or
 * a `Communication` entity with no roles.
 *
 * Exported for unit-testing.
 */
export function resolveLibraryCapabilityConfig(cap, ctx) {
  const {
    entityName,
    entityNamePlural,
    definition,
    relationships,
    belongsTo,
    repositoryDir,
    srcRoot,
    entityLookup,
  } = ctx;
  const importFrom = (target) => {
    const rel = path.posix.relative(repositoryDir, target);
    return rel.startsWith('.') ? rel : `./${rel}`;
  };
  const modulesRoot = `${srcRoot}/modules`;

  if (cap.name === COMMUNICATION_CAPABILITY) {
    const declared = definition.roles || {};
    const roles = {};
    const imports = [];
    for (const [role, def] of Object.entries(declared)) {
      if (def.cardinality === 'one') {
        const fk = belongsTo.find((r) => r.role === role);
        if (!fk) {
          throw new Error(
            `[codegen] '${entityName}' role '${role}': no derived belongs_to — was the roles: block merged?`,
          );
        }
        roles[role] = { cardinality: 'one', target: def.target, column: fk.camelField };
        continue;
      }
      const junctionPlural = pluralize(def.via);
      const table = camelCase(junctionPlural);
      roles[role] = {
        cardinality: 'many',
        target: def.target,
        via: {
          table: identifierRef(table),
          self: camelCase(`${entityName}_id`),
          target: camelCase(`${def.target}_id`),
        },
      };
      imports.push({
        name: table,
        importPath: importFrom(`${modulesRoot}/${junctionPlural}/${def.via}.entity`),
      });
    }
    if (Object.keys(roles).length === 0) {
      throw new Error(
        `[codegen] '${entityName}' declares the '${COMMUNICATION_CAPABILITY}' capability but no roles: — ` +
          `the two imply each other.`,
      );
    }
    return { config: { roles }, imports };
  }

  if (cap.name === ACTOR_CAPABILITY) {
    const parsed = cap.configSchema ? cap.configSchema.safeParse(cap.config ?? undefined) : null;
    if (!parsed || !parsed.success) {
      const detail = parsed
        ? parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join(', ')
        : 'no config schema';
      throw new Error(
        `[codegen] '${entityName}' declares the '${ACTOR_CAPABILITY}' capability, whose config is ` +
          `required: config: { ${ACTOR_CAPABILITY}: { kind: individual } } or ` +
          `{ kind: group, members: <has_many relationship> } (${detail}).`,
      );
    }
    const config = parsed.data;
    if (config.kind === 'individual') return { config: { kind: 'individual' }, imports: [] };
    const members = relationships[config.members];
    if (!members || members.type !== 'has_many') {
      throw new Error(
        `[codegen] '${entityName}' ${ACTOR_CAPABILITY} members: '${config.members}' must name one of ` +
          `its has_many relationships.`,
      );
    }
    const foreignKey = camelCase(members.foreign_key);
    // A self-referential group (members of an account are accounts): the
    // table is this entity's own, already imported by the repository.
    if (members.target === entityName) {
      return {
        config: { kind: 'group', members: { table: identifierRef(entityNamePlural), foreignKey } },
        imports: [],
      };
    }
    // The member entity's table export and module folder come from ITS YAML
    // (`plural:`, `context:`) — never re-pluralized here (charter I1).
    const target = entityLookup ? entityLookup(members.target) : null;
    if (!target) {
      throw new Error(
        `[codegen] '${entityName}' ${ACTOR_CAPABILITY} members: '${config.members}' targets ` +
          `'${members.target}', which has no entity YAML in the entities directory.`,
      );
    }
    const naming = entityModuleNaming(target, srcRoot);
    return {
      config: {
        kind: 'group',
        members: { table: identifierRef(naming.plural), foreignKey },
      },
      imports: [{ name: naming.plural, importPath: importFrom(naming.entityFile) }],
    };
  }

  return null;
}

/**
 * Resolve an entity's composition (ADR-041): one inherited **spine** plus N
 * layered **capabilities**.
 *
 * Replaces the PATTERN-5 `resolvePatternBaseClasses()`, whose rule was
 * positional — `patterns[0]` won the base class and every later pattern's
 * `repositoryClass` / `serviceClass` was silently dropped. Two things changed
 * (ADR-041 §2/§3):
 *
 *   - the spine is the declared domain pattern that contributes an inheritable
 *     base, *wherever it sits in the list*, and two of them is a hard error
 *     rather than a silent drop;
 *   - a `kind: 'capability'` pattern is layered as a repository mixin and/or a
 *     set of service forwarders instead of being dropped.
 *
 * Throws on a composition error. Generation time is ADR-041 §4's authoritative
 * gate — `validatePatternComposition()` reports the same errors earlier and
 * more cheaply, but nothing forces a consumer to run it before `entity new`.
 *
 * Exported for unit-testing; consumers import `buildCleanLitePsLocals`.
 */
export function resolvePatternComposition(entity) {
  const names = declaredPatternNames(entity);
  const composed = composePatterns(names, getPattern, { entity: entity.name });

  if (composed.errors.length > 0) {
    throw new Error(
      `[codegen] pattern composition failed for '${entity.name}':\n  ` +
      composed.errors.map((e) => e.message).join('\n  '),
    );
  }

  const def = composed.spine;
  if (!def) {
    throw new Error(
      `Pattern '${composed.spineName}' is not registered, and the library 'Base' ` +
      `pattern is also missing. Did the patterns barrel fail to load?`,
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
    capabilities: composed.capabilities,
  };
}

/**
 * Resolve the behaviors implied by an entity's declared pattern(s).
 *
 * A pattern (e.g. `Integrated`) may declare `impliedBehaviors` — behaviors the
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
const singularize = (s) => pluralizePkg.singular(s);

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

  // Column defaults (#345). The value is validated upstream (schema `default:`).
  // Covers every scalar type, enum literals, and the `now` sentinel on
  // timestamp/date columns — not just booleans.
  if (hasDefault) {
    chain += renderColumnDefault(field.default, drizzleType);
  }

  return chain;
}

/**
 * Render a Drizzle `.default(...)` (or `.defaultNow()`) suffix for a column.
 *
 * - timestamp/date + a `now`/`now()`/`current_timestamp` sentinel → `.defaultNow()`
 * - numeric (Drizzle returns it as a string) → quoted, even for numeric YAML values
 * - string / enum literal → single-quoted, escaped
 * - number / boolean → bare literal
 * - anything else (jsonb object/array default) → JSON literal
 */
function renderColumnDefault(value, drizzleType) {
  if (
    (drizzleType === 'timestamp' || drizzleType === 'date') &&
    typeof value === 'string' &&
    /^(now|now\(\)|current_timestamp)$/i.test(value)
  ) {
    return '.defaultNow()';
  }
  if (drizzleType === 'numeric') {
    return `.default('${String(value)}')`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `.default(${value})`;
  }
  if (typeof value === 'string') {
    return `.default('${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
  }
  return `.default(${JSON.stringify(value)})`;
}

/**
 * Process entity fields into ProcessedField[].
 *
 * `entityName` (snake_case) namespaces enum-typed fields so two entities that
 * each declare an enum field with the SAME name (e.g. `role`, `status`) don't
 * collide. Without it the pg type name AND the exported const were derived from
 * the field name alone, so a second entity with the same enum field produced a
 * duplicate `export const roleEnum` (TS2308) and a duplicate `CREATE TYPE role`
 * at the DB level (a real migration conflict). Namespacing yields
 * `field_config_role` (pg type) / `fieldConfigRoleEnum` (export) instead.
 */
function processFields(fields, entityName = '') {
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
    // Namespace the enum const + pg type name by entity so same-named enum
    // fields on different entities don't collide (TS2308 / duplicate CREATE TYPE).
    // The COLUMN name keeps the bare snake field name (`role`); only the const
    // (`fieldConfigRoleEnum`) and pg type (`field_config_role`) are namespaced.
    const enumDbName = hasChoices
      ? (entityName ? `${entityName}_${fieldName}` : fieldName)
      : null;
    const enumName = hasChoices ? camelCase(enumDbName) + 'Enum' : null;
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
      enumDbName,
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
 *
 * `fields` is the raw `fields:` map (snake_case keyed). When the FK column is
 * ALSO declared as a field (e.g. `conversation_id: { type: uuid, required:
 * true, index: true }`), the belongs_to column must inherit that field's
 * `required`/`nullable` (→ `.notNull()`) and `index: true` (→ a single-column
 * index). The relationship moves the column out of `clpProcessedFields`, so
 * those declarations would otherwise be silently dropped. An explicit
 * `nullable:` on the relationship still wins (back-compat for fixtures that set
 * it directly on the relation).
 */
function processBelongsTo(relationships, parentEntityNamePlural, fields = {}) {
  if (!relationships) return [];

  const result = [];

  for (const [relName, rel] of Object.entries(relationships)) {
    if (rel.type !== 'belongs_to') continue;

    const target = rel.target;
    const field = rel.foreign_key;
    // Inherit nullability from the underlying field declaration when present.
    // Precedence: explicit relationship `nullable:` → field `required`/`nullable`
    // → default nullable (true). A `required: true` field is NOT NULL.
    const fieldDef = fields[field];
    let nullable;
    if (rel.nullable !== undefined && rel.nullable !== null) {
      nullable = rel.nullable;
    } else if (fieldDef) {
      if (fieldDef.required === true) {
        nullable = false;
      } else if (fieldDef.nullable !== undefined && fieldDef.nullable !== null) {
        nullable = fieldDef.nullable;
      } else {
        nullable = true;
      }
    } else {
      nullable = true;
    }
    // Carry the field's `index: true` so the table-constraints builder can emit
    // the same single-column index a non-FK field would get.
    //
    // CAP-2: a role-derived FK is indexed by DEFAULT — a role edge exists to be
    // traversed. Declaring the FK column in `fields:` is still the way to say
    // otherwise, so an explicit field declaration wins in both directions.
    const hasIndex = fieldDef ? fieldDef.index === true : rel.index === true;
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
    if (rel.role) {
      // CAP-2: a role names its own edge. Keying by target would give `host:
      // contact` and `organizer: contact` one method name between them, and
      // describe two graph edges with one name.
      relationKey = camelCase(rel.role);
    } else if (isSelfFk) {
      // parent_account_id → parent_account → parentAccount
      const base = field.endsWith('_id') ? field.slice(0, -3) : field;
      relationKey = camelCase(base);
    } else {
      relationKey = target;
    }

    result.push({
      field,
      role: rel.role ?? null,
      camelField: camelCase(field),
      relatedEntity: target,
      relatedEntityPascal: pascalCase(target),
      relatedTable: relatedPlural,
      relatedPlural,
      nullable,
      hasIndex,
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
 * Field-level `foreign_key:` + `index:` emission (#354, #355).
 *
 * Distinct from `relationships:`-driven belongs_to FKs (processBelongsTo),
 * which own their own column + import. This handles features declared
 * directly on a column field:
 *
 *   - `foreign_key: <table>.<column>` → append `.references(() => <table>.<column>)`
 *     to the column's Drizzle chain (self-FKs get the `: AnyPgColumn` annotation)
 *     and record the cross-module import. The table segment is the Drizzle table
 *     export name (plural, e.g. `conversations`); the import path singularizes it
 *     to the entity file (`../conversations/conversation.entity`).
 *
 *     **Host-owned tables (#636).** A `<table>` that no entity YAML generates
 *     belongs to the host application — a tenants table, a users table from an
 *     auth provider. That is a legitimate declaration, not an error: the
 *     reference is real, it is simply not codegen's to enforce. The column is
 *     emitted PLAIN — no `.references()`, no import — because the alternative
 *     is an import of a module codegen never writes. Referential integrity for
 *     a host-owned table is the host's, in its own migration. This is the same
 *     shape as the `tenant_id` column `tenant_scoped: true` emits (ADR-042):
 *     a bare `uuid`, pointing at a table codegen does not own.
 *   - `index: true` → emit a named single-column index in the pgTable
 *     extra-config callback (`<table>_<column>_idx`).
 *
 * Mutates each processed field's `drizzleChain` in place (the same objects are
 * later rendered via clpProcessedFields). Returns the imports + index
 * expressions the template needs.
 *
 * @param {object[]} renderedFields  the fields actually emitted as columns
 *                                   (nonFkFields — belongs_to FK columns excluded)
 * @param {object}   fields          raw field map keyed by snake_case name
 * @param {string}   entityNamePlural Drizzle table export name for self-FK detection
 * @param {Set<string>|string[]} [ownedTables] table names codegen generates; a
 *   `foreign_key` outside this set is host-owned and emits no DB-level FK.
 *   Absent → every target is treated as owned (the pre-#636 behaviour), which
 *   only happens when a caller builds locals without prompt.js.
 */
function processFieldFeatures(renderedFields, fields, entityNamePlural, ownedTables) {
  const owned = ownedTables === undefined
    ? null
    : (ownedTables instanceof Set ? ownedTables : new Set(ownedTables));
  const fkImports = [];
  const indexExpressions = [];
  const seenImports = new Set();
  let hasSelfFieldFk = false;

  for (const pf of renderedFields) {
    const field = fields[pf.name];
    if (!field) continue;

    // --- foreign_key (#354) ---
    if (typeof field.foreign_key === 'string' && field.foreign_key.includes('.')) {
      const [relatedTable, fkColumn] = field.foreign_key.split('.');
      const isSelfFk = relatedTable === entityNamePlural;
      // #636 — a target codegen does not generate is host-owned: emit the
      // column with no DB-level FK and no import rather than an import that
      // cannot resolve. Self-FKs are owned by definition.
      const isOwned = isSelfFk || owned === null || owned.has(relatedTable);
      if (isOwned) {
        pf.drizzleChain += isSelfFk
          ? `.references((): AnyPgColumn => ${relatedTable}.${fkColumn})`
          : `.references(() => ${relatedTable}.${fkColumn})`;

        if (isSelfFk) {
          hasSelfFieldFk = true;
        } else if (!seenImports.has(relatedTable)) {
          seenImports.add(relatedTable);
          fkImports.push({
            relatedTable,
            importPath: `../${relatedTable}/${singularize(relatedTable)}.entity`,
          });
        }
      }
      // else: host-owned target — plain column, no FK, no import. `index: true`
      // below still applies; a host-owned reference is usually worth indexing.
    }

    // --- index: true (#355) ---
    if (field.index === true) {
      indexExpressions.push({
        comment: null,
        expr: `index('${entityNamePlural}_${pf.name}_idx').on(t.${pf.camelName})`,
      });
    }
  }

  return { fkImports, indexExpressions, hasSelfFieldFk };
}

/**
 * Composite unique index emission (#356).
 *
 * Top-level `unique_indexes: [{ fields: [...], name? }]` → a `uniqueIndex(...)`
 * entry in the pgTable extra-config callback. Column names are camelCased to
 * match the emitted Drizzle column identifiers; they may reference FK columns
 * (belongs_to) or ordinary fields. Index name defaults to
 * `<table>_<col1>_<col2>_..._uniq`.
 */
function processUniqueIndexes(uniqueIndexes, entityNamePlural, tenantScoped = false) {
  if (!Array.isArray(uniqueIndexes)) return [];

  return uniqueIndexes.map((ui) => {
    // A tenant-scoped entity's natural keys are unique WITHIN a tenant, not
    // globally: tenant A and tenant B may each hold a row with the same
    // `(conversation_id, sequence)`. A bare composite would forbid that, which
    // is the exact failure ADR-042 §5(c) is about. An author-supplied `name` is
    // preserved verbatim — they asked for that constraint name.
    const cols = tenantScoped ? ['tenant_id', ...ui.fields] : ui.fields;
    const name = ui.name || `${entityNamePlural}_${cols.join('_')}_uniq`;
    const onCols = cols.map((c) => `t.${camelCase(c)}`).join(', ');
    return {
      comment: tenantScoped
        ? 'tenant_scoped — uniqueness is per tenant (ADR-042)'
        : null,
      expr: `uniqueIndex('${name}').on(${onCols})`,
    };
  });
}

/**
 * Collect drizzle imports needed for entity fields
 */
function collectDrizzleImports(processedFields, belongsTo, hasTimestamps, hasSoftDelete, hasExternalIdTracking, extraImports = []) {
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
  // integration sink's integrationUpsert relies on.
  if (hasExternalIdTracking) {
    imports.add('varchar');
    imports.add('jsonb');
    imports.add('uniqueIndex');
  }

  // Caller-supplied extras: `index` (field-level index: true) and
  // `uniqueIndex` (composite unique_indexes) — see processFieldFeatures /
  // processUniqueIndexes.
  for (const extra of extraImports) {
    imports.add(extra);
  }

  return Array.from(imports).sort();
}

/**
 * Derive Zod chain for a field in create DTO context
 */
function zodChainForCreate(field) {
  const { type, nullable, required, hasDefault, hasChoices, choices } = field;

  // Apply nullability and optionality INDEPENDENTLY. A nullable column accepts
  // null (`.nullable()`); a field without `required: true` may be omitted from
  // the create payload (`.optional()`). A field that is both gets
  // `.nullable().optional()`. Previously the `nullable` branch returned early,
  // so a nullable-and-optional field never got `.optional()` — forcing callers
  // to send an explicit `null` for every optional column (e.g. POST /accounts
  // rejecting a body that omits `domain`/`industry`).
  if (hasChoices) {
    let base = `z.enum([${choices.map((c) => `'${c}'`).join(', ')}])`;
    if (nullable) base += '.nullable()';
    if (!required) base += '.optional()';
    return base;
  }

  let base = ZOD_TYPE_MAP[type] || 'z.unknown()';

  if (type === 'boolean' && hasDefault) {
    // `.default()` already makes the input optional in Zod.
    base += `.default(${field.default ?? false})`;
    return base;
  }

  if (nullable) base += '.nullable()';
  if (!required) base += '.optional()';
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
// Integration write-surface derivation (#374)
// ============================================================================

/**
 * Shared delete-knob → softDelete boolean mapping rule (#490).
 *
 * Applied at BOTH derivations (repo config + sink body) so the two always agree:
 *   soft      → true  (set deletedAt)
 *   tombstone → false (null externalId/provider)
 *   absent    → !!hasSoftDelete  (preserve today's default)
 *   noop      → !!hasSoftDelete  (repo config irrelevant for noop — sink short-circuits)
 *
 * The sink only needs 'delegate' | 'noop' for its body decision; this helper
 * is for the REPO config boolean. Mirrored verbatim in buildSinkInput caller
 * (adapter-emission-generator.ts) for the contract test (spec Tests §3d).
 *
 * @param {'soft'|'tombstone'|'noop'|undefined} deleteKnob
 * @param {boolean} hasSoftDelete
 * @returns {boolean}
 */
export function resolveSoftDeleteBoolean(deleteKnob, hasSoftDelete) {
  if (deleteKnob === 'soft') return true;
  if (deleteKnob === 'tombstone') return false;
  return !!hasSoftDelete; // absent OR noop → preserve current default
}

/**
 * Pre-compute the inbound-integration write surface for a `pattern: Integrated` entity.
 * Keeps the EJS thin + unit-testable: the template hand-emits the integrationConfig
 * literal (so `refTable` can carry a LIVE Drizzle table handle, which
 * renderPatternConfigLiteral cannot express) using these locals.
 *
 * Returns null when the entity is not Integrated.
 *
 * @param {string} patternName     resolved pattern name
 * @param {object[]} processedFields  nonFkFields (camel + tsType + nullable)
 * @param {object[]} belongsTo      clpBelongsTo entries
 * @param {boolean} hasTimestamps
 * @param {boolean} eavEnabled
 * @param {boolean} hasSoftDelete
 * @param {object} [fields]           raw entity fields (for FK strict detection)
 * @param {object} [sinkPolicy]       integration.sink knobs {delete?, exclude_fields?}
 * @param {boolean} [tenantScoped]    entity `tenant_scoped: true` (ADR-042) —
 *   prefixes the ON CONFLICT target with tenant_id
 */
export function buildIntegrationSurface(patternName, processedFields, belongsTo, hasTimestamps, eavEnabled, hasSoftDelete, fields, sinkPolicy, tenantScoped = false) {
  if (patternName !== 'Integrated') return null;

  // Per-field exclusion (#490): drop declared-excluded fields from copy-through.
  // Exclusion targets copy-through scalars only (FK columns and user_id are
  // rejected at schema validation — the schema superRefine guards both).
  // Match on snake_case `name` (how processedFields.name is keyed) so a
  // multi-word field like `conversation_external_id` matches correctly.
  const excludeSet = new Set(sinkPolicy?.exclude_fields ?? []);

  // Copy-through columns: every non-FK declared field. external_id_tracking
  // columns (external_id/provider/provider_metadata) are injected by the
  // behavior, NOT present in processedFields, so they're already excluded.
  // Excluded fields (#490) are also dropped here — they are removed from the
  // copy-through write surface so integrationUpsertOne never clobbers them.
  const writeColumns = processedFields
    .filter((f) => !excludeSet.has(f.name))
    .map((f) => f.camelName);

  // FK resolvers — one per belongs_to. writeKey = `${relationKey}ExternalId`
  // (Decision 4). refTable is the string 'self' for self-FKs, else the parent
  // table var name (emitted as a live identifier by the template).
  const fkResolvers = belongsTo.map((rel) => ({
    column: rel.camelField,
    writeKey: `${rel.relationKey}ExternalId`,
    refTable: rel.isSelfFk ? 'self' : rel.relatedTable,
    isSelfFk: rel.isSelfFk,
    nullable: rel.nullable,
    // Strict resolution (throw on unresolved parent → failed item) when the FK
    // COLUMN is required/non-null; opportunistic null otherwise. Sourced from
    // the FK field's `required` — the relationship-level `nullable` is
    // unreliable (defaults true when undeclared, e.g. a `belongs_to` with no
    // explicit `nullable:`). Nullable FKs (e.g. self-FK hierarchies) stay
    // opportunistic. (#374)
    strict: fields?.[rel.field]?.required === true,
    relatedTable: rel.relatedTable,
    relatedEntity: rel.relatedEntity,
    importPath: rel.importPath,
  }));

  // Projection columns: id + externalId + ALL copy-through columns + local FK
  // columns + timestamps. Omits provider/provider_metadata.
  // Projection keeps excluded fields (#490) — exclusion is write-surface only.
  // The find VIEW also keeps them (bare passthroughs); diff-soundness holds via
  // the differ's `key in incoming` guard, not by omitting them from the view.
  const projectionColumns = [
    'id',
    'externalId',
    ...processedFields.map((f) => f.camelName),
    ...belongsTo.map((rel) => rel.camelField),
    ...(hasTimestamps ? ['createdAt', 'updatedAt'] : []),
  ];

  // The integrationConfig object literal the template hand-emits. fkResolvers carry a
  // sentinel so the template can swap `refTable` to either 'self' or the live
  // table identifier.
  // softDelete: use resolveSoftDeleteBoolean (delete knob takes precedence over
  // !!hasSoftDelete default; noop/absent both preserve !!hasSoftDelete, spec §Delete).
  const integrationConfig = {
    // A tenant-scoped entity upserts on (tenant_id, provider, external_id) —
    // the generated config states it, so the runtime never has to introspect
    // the table to find out (charter I1). Matches the emitted `unique(...)`
    // constraint above.
    conflictTarget: tenantScoped
      ? ['tenantId', 'provider', 'externalId']
      : ['provider', 'externalId'],
    writeColumns,
    projectionColumns,
    eav: !!eavEnabled,
    softDelete: resolveSoftDeleteBoolean(sinkPolicy?.delete, hasSoftDelete),
  };

  // TIntegrationWrite fields: externalId:string, copy-through (typed, nullable-aware),
  // one `<writeKey>?: string | null` per FK, fields?: Record<string, unknown>.
  // Excluded fields (#490) are dropped from writeFields too — same exclusion set
  // as writeColumns. The projection keeps them (projectionFields below).
  const writeFields = processedFields
    .filter((f) => !excludeSet.has(f.name))
    .map((f) => ({
      camelName: f.camelName,
      tsType: f.nullable ? `${f.tsType} | null` : f.tsType,
    }));
  const writeFkFields = fkResolvers.map((fk) => ({
    name: fk.writeKey,
    tsType: 'string | null',
  }));

  // TIntegrationProjection fields: id + externalId + copy-through (typed) + each local
  // FK column (typed string, nullable per rel) + createdAt/updatedAt.
  const projectionFields = [
    { camelName: 'id', tsType: 'string' },
    { camelName: 'externalId', tsType: 'string' },
    ...processedFields.map((f) => ({
      camelName: f.camelName,
      tsType: f.nullable ? `${f.tsType} | null` : f.tsType,
    })),
    ...belongsTo.map((rel) => ({
      camelName: rel.camelField,
      tsType: rel.nullable ? 'string | null' : 'string',
    })),
    ...(hasTimestamps
      ? [
          { camelName: 'createdAt', tsType: 'Date' },
          { camelName: 'updatedAt', tsType: 'Date' },
        ]
      : []),
  ];

  // Parent-table imports for non-self FKs, deduped (#368). Each entry imports
  // the parent table var from its entity file. The entity's OWN table import is
  // emitted separately by the template; we exclude self-FKs here.
  const parentImportMap = new Map();
  for (const fk of fkResolvers) {
    if (fk.isSelfFk) continue;
    if (!parentImportMap.has(fk.relatedTable)) {
      parentImportMap.set(fk.relatedTable, {
        table: fk.relatedTable,
        importPath: fk.importPath,
      });
    }
  }
  const parentTableImports = Array.from(parentImportMap.values());

  return {
    integrationConfig,
    fkResolvers,
    writeFields,
    writeFkFields,
    projectionFields,
    parentTableImports,
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
  // ADR-043 §6: `api: false` suppresses the HTTP surface (controller + search
  // controller + their module wiring) while keeping the entity/repository/
  // service/use-cases in-process reachable. Defaults to true.
  const clpApiEnabled = definition.api !== false;

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
  // One naming rule for this entity and for any entity that references it
  // (`entityModuleNaming`).
  const ownNaming = entityModuleNaming(entity, srcRoot);
  const entityNamePlural = ownNaming.plural;
  const entityNamePluralPascal = pascalCase(entityNamePlural);

  // #403: bounded-context folder grouping. `entity.context:` nests this
  // entity's module folder under that segment so same-context entities group
  // together (`<modules>/<context>/<plural>/`); no context → flat
  // (`<modules>/<plural>/`, byte-identical to pre-#403). Emit-folder-only —
  // every intra-module import is folder-relative and therefore unaffected, and
  // the generated barrel recomputes its import paths from the full file paths
  // below. The module-folder base used by every clpOutputPaths entry:
  const entityContext = entity.context || null;
  const moduleGroupDir = ownNaming.moduleGroupDir;

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

  // Pattern resolution — registry-driven (ADR-031, PATTERN-5) and composed
  // (ADR-041): one inherited spine + N layered capabilities.
  //
  // The prior PATTERN-3 bridge that lowercased the pattern name to index
  // FAMILY_MAP is gone; the registry returns the canonical record. The
  // shape returned by `resolvePatternComposition` matches the legacy
  // FAMILY_MAP entries verbatim for the five library patterns so the
  // emitted output is byte-identical for every entity that declares no
  // capability.
  const patternBase = resolvePatternComposition(entity);
  const { patternName } = patternBase;
  // Runtime mode (ADR-037) — rewrite library base-class imports authored as
  // `@shared/base-classes/…` to the mode-correct form (package mode →
  // `@pattern-stack/codegen/runtime/base-classes/…`). App-defined pattern
  // aliases (non-`@shared/`) pass through untouched.
  const runtimeMode = baseLocals?.runtimeMode === 'vendored' ? 'vendored' : 'package';
  // FAMILY_MAP is gone (PATTERN-5); `patternConfigClasses` is the structural
  // equivalent — repository + service class names + import paths + inherited
  // method comment lists, sourced directly from the pattern registry.
  const patternConfigClasses = {
    repositoryBaseClass: patternBase.repositoryBaseClass,
    serviceBaseClass: patternBase.serviceBaseClass,
    repositoryBaseImport: rewriteSharedImport(runtimeMode, patternBase.repositoryBaseImport),
    serviceBaseImport: rewriteSharedImport(runtimeMode, patternBase.serviceBaseImport),
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

  // Capability layering (ADR-041). Declaration order is nesting order with the
  // RIGHTMOST outermost, so `patterns: [Integrated, A, B]` emits `B(A(Spine))`.
  //
  // `mixinImport` gets the same runtime-mode rewrite as the base-class imports:
  // a library capability authors `@shared/base-classes/…`, an app capability's
  // own alias (`@modules/…`, `@/patterns/…`) passes through untouched.
  const capabilityMixins = [];
  const capabilityForwarders = [];
  for (const cap of patternBase.capabilities) {
    const capConfigBlock =
      (definition.config && definition.config[cap.name]) ||
      (definition.entity && definition.entity.config && definition.entity.config[cap.name]) ||
      null;
    const hasCapConfig =
      capConfigBlock != null &&
      typeof capConfigBlock === 'object' &&
      Object.keys(capConfigBlock).length > 0;
    if (cap.mixin) {
      capabilityMixins.push({
        name: cap.name,
        mixin: cap.mixin,
        importPath: rewriteSharedImport(runtimeMode, cap.mixinImport),
        // The property the concrete repository fills with this capability's
        // `config:` block. The mixin declares it; the generated property is
        // emitted with `override`.
        configProperty: cap.configProperty || `${camelCase(cap.name.charAt(0).toLowerCase() + cap.name.slice(1))}Config`,
        config: capConfigBlock,
        hasConfig: hasCapConfig,
        // Read by `resolveLibraryCapabilityConfig` to validate at generation.
        configSchema: cap.configSchema,
      });
    }
    for (const method of cap.forwarderMethods ?? []) {
      capabilityForwarders.push({ capability: cap.name, method });
    }
  }

  // Process entity fields. Pass the entity name so enum fields namespace their
  // pg type + exported const by entity (prevents same-named enum collisions
  // across entities — TS2308 / duplicate CREATE TYPE).
  const processedFields = processFields(fields, entityName);

  // Behavior flags (re-read from behaviors array for clean-lite-ps use).
  //
  // Fold in the resolved pattern's `impliedBehaviors` (ADR-031): an entity
  // declaring e.g. `pattern: Integrated` need not re-declare the
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

  // ==========================================================================
  // Tenant scoping (ADR-042 / TEN-1). One YAML flag drives the column, the
  // index, the uniqueness prefix, the BehaviorConfig field and the repository's
  // strict enforcement — one declaration, five emissions (charter I1).
  // ==========================================================================
  const tenantScoped = definition.tenant_scoped === true;

  // A tenant-scoped entity whose repository would upsert on a caller-supplied
  // conflict target is a cross-tenant WRITE waiting to happen: the ON CONFLICT
  // target selects the row before any WHERE applies. The EAV value-table
  // repository emits exactly that (`upsertCurrentValues`), and its conflict
  // target is author-declared, so it cannot be prefixed with `tenant_id`
  // without breaking index inference. Refuse the combination rather than emit a
  // repository that claims an isolation it does not have (TEN-1 §5.2).
  if (tenantScoped && eavValueTable) {
    throw new Error(
      `Entity '${entityName}': tenant_scoped: true is not supported with ` +
        'eav_value_table: true. The generated upsertCurrentValues() upserts on ' +
        'an author-declared conflict target, which cannot carry tenant_id, so ' +
        "one tenant's batch would update another tenant's rows. Drop one of " +
        'the two flags. See ADR-042 and docs/specs/TEN-1.md §5.2.',
    );
  }

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

  // Process belongs_to relationships. Pass the raw fields map so a FK column
  // also declared as a field inherits its `required`/`nullable` (→ .notNull())
  // and `index: true` (→ a single-column index emitted below).
  const belongsTo = processBelongsTo(relationships, entityNamePlural, fields);

  // Process has_many relationships (CGP-358b)
  const hasMany = processHasMany(relationships, entityNamePlural, fs, path, srcRoot);

  // ADR-041.1 — the two library capabilities' configs are RESOLVED, not copied:
  // `Communication`'s comes from `roles:` (never authored), `Actor`'s `members:`
  // names a has_many whose table + FK codegen looks up. The result replaces the
  // verbatim `config:` block on the matching `capabilityMixins` entry, and the
  // tables it references become repository imports.
  const capabilityConfigImports = [];
  for (const cap of capabilityMixins) {
    const resolved = resolveLibraryCapabilityConfig(cap, {
      entityName,
      entityNamePlural,
      definition,
      relationships,
      belongsTo,
      repositoryDir: `${moduleGroupDir}/${entityNamePlural}`,
      srcRoot,
      entityLookup: baseLocals?.entityLookup,
    });
    if (!resolved) continue;
    cap.config = resolved.config;
    cap.hasConfig = true;
    for (const imp of resolved.imports) {
      if (!capabilityConfigImports.some((i) => i.name === imp.name)) {
        capabilityConfigImports.push(imp);
      }
    }
  }

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

  // Field-level foreign_key + index emission (#354, #355). Mutates the
  // drizzleChain of the rendered (non-belongs_to) columns in place. Skip FK
  // imports for tables belongs_to already imports to avoid duplicate import
  // lines.
  const fieldFeatures = processFieldFeatures(
    nonFkFields,
    fields,
    entityNamePlural,
    baseLocals?.ownedTableNames,
  );
  const belongsToTables = new Set(belongsTo.map((r) => r.relatedTable));
  const clpFieldFkImports = fieldFeatures.fkImports.filter(
    (imp) => !belongsToTables.has(imp.relatedTable),
  );

  // Composite unique indexes (#356).
  const uniqueIndexExpressions = processUniqueIndexes(
    definition.unique_indexes,
    entityNamePlural,
    tenantScoped,
  );

  // belongs_to FK columns that declared `index: true` on their underlying
  // field. The FK column lives in clpBelongsTo (not clpProcessedFields), so
  // processFieldFeatures never sees it — emit its index here using the same
  // `<table>_<col>_idx` naming a non-FK indexed field gets.
  const belongsToIndexExpressions = belongsTo
    .filter((rel) => rel.hasIndex)
    .map((rel) => ({
      comment: null,
      expr: `index('${entityNamePlural}_${rel.field}_idx').on(t.${rel.camelField})`,
    }));

  // pgTable extra-config callback entries, in emission order: belongs_to FK
  // indexes, single-column field indexes, composite unique indexes, then the
  // external_id_tracking unique index (the ON CONFLICT target integrationUpsert
  // relies on).
  const clpTableConstraints = [
    ...belongsToIndexExpressions,
    ...fieldFeatures.indexExpressions,
    ...uniqueIndexExpressions,
  ];
  if (tenantScoped) {
    // Every scoped read filters on this column, so it is indexed unconditionally.
    clpTableConstraints.unshift({
      comment: 'tenant_scoped behavior (ADR-042) — every scoped read filters on tenant_id',
      expr: `index('${entityNamePlural}_tenant_id_idx').on(t.tenantId)`,
    });
  }
  if (hasExternalIdTracking) {
    clpTableConstraints.push(
      tenantScoped
        ? {
            // `unique(...)`, not `uniqueIndex(...)`: only the table-constraint
            // builder carries `.nullsNotDistinct()` on drizzle 1.0.0-rc.4, and
            // the tenant column is nullable-first. Postgres treats NULLs in a
            // unique index as DISTINCT, so a `(NULL, provider, external_id)`
            // conflict target would never fire and the integration upsert would
            // insert a duplicate row for null-tenant work instead of updating.
            comment:
              'external_id_tracking + tenant_scoped — per-tenant ON CONFLICT target for integrationUpsert',
            expr:
              `unique('uq_${entityNamePlural}_tenant_provider_external_id')` +
              '.on(t.tenantId, t.provider, t.externalId).nullsNotDistinct()',
          }
        : {
            comment: 'external_id_tracking behavior — ON CONFLICT target for integrationUpsert',
            expr: `uniqueIndex('uq_${entityNamePlural}_provider_external_id').on(t.provider, t.externalId)`,
          },
    );
  }

  // Enum field declarations — surface a separate collection so the entity
  // template can emit `export const xEnum = pgEnum('x', [...])` ahead of
  // the `pgTable(...)` block. Both FK-filtered and unfiltered processing
  // include the same enum fields; they're never FKs.
  //
  // `dbName` is the Postgres TYPE name — namespaced by entity
  // (`field_config_role`) so two entities with a same-named enum field don't
  // emit duplicate `CREATE TYPE`s. The COLUMN name is still the bare field
  // name and is carried by the column reference (`f.name`) in the entity
  // template, not here.
  const clpEnumFields = processedFields
    .filter((f) => f.hasChoices && f.enumName)
    .map((f) => ({
      enumName: f.enumName,
      dbName: f.enumDbName,
      choices: f.choices,
    }));

  // Drizzle imports needed. `index` / `uniqueIndex` are pulled in only when a
  // field declares `index: true` or the entity declares `unique_indexes:`
  // (external_id_tracking adds `uniqueIndex` on its own flag below).
  const extraDrizzleImports = [];
  if (
    fieldFeatures.indexExpressions.length > 0 ||
    belongsToIndexExpressions.length > 0 ||
    tenantScoped
  ) {
    extraDrizzleImports.push('index');
  }
  if (uniqueIndexExpressions.length > 0) extraDrizzleImports.push('uniqueIndex');
  // The per-tenant external-id constraint is a `unique(...)` table constraint,
  // not a `uniqueIndex(...)` — see clpTableConstraints above.
  if (tenantScoped && hasExternalIdTracking) extraDrizzleImports.push('unique');
  const drizzleEntityImports = collectDrizzleImports(processedFields, belongsTo, hasTimestamps, hasSoftDelete, hasExternalIdTracking, extraDrizzleImports);

  // Output paths
  const outputPaths = {
    entity: `${moduleGroupDir}/${entityNamePlural}/${entityName}.entity.ts`,
    repository: `${moduleGroupDir}/${entityNamePlural}/${entityName}.repository.ts`,
    service: `${moduleGroupDir}/${entityNamePlural}/${entityName}.service.ts`,
    controller: `${moduleGroupDir}/${entityNamePlural}/${entityName}.controller.ts`,
    module: `${moduleGroupDir}/${entityNamePlural}/${entityNamePlural}.module.ts`,
    index: `${moduleGroupDir}/${entityNamePlural}/index.ts`,
    findByIdUseCase: `${moduleGroupDir}/${entityNamePlural}/use-cases/find-${entityName}-by-id.use-case.ts`,
    listUseCase: `${moduleGroupDir}/${entityNamePlural}/use-cases/list-${entityNamePlural}.use-case.ts`,
    findByIdWithFieldsUseCase: eavEnabled
      ? `${moduleGroupDir}/${entityNamePlural}/use-cases/find-${entityName}-by-id-with-fields.use-case.ts`
      : null,
    listWithFieldsUseCase: eavEnabled
      ? `${moduleGroupDir}/${entityNamePlural}/use-cases/list-${entityNamePlural}-with-fields.use-case.ts`
      : null,
    createUseCase: generateWrites
      ? `${moduleGroupDir}/${entityNamePlural}/use-cases/create-${entityName}.use-case.ts`
      : null,
    updateUseCase: generateWrites
      ? `${moduleGroupDir}/${entityNamePlural}/use-cases/update-${entityName}.use-case.ts`
      : null,
    deleteUseCase: generateWrites
      ? `${moduleGroupDir}/${entityNamePlural}/use-cases/delete-${entityName}.use-case.ts`
      : null,
    createDto: `${moduleGroupDir}/${entityNamePlural}/dto/create-${entityName}.dto.ts`,
    updateDto: `${moduleGroupDir}/${entityNamePlural}/dto/update-${entityName}.dto.ts`,
    outputDto: `${moduleGroupDir}/${entityNamePlural}/dto/${entityName}-output.dto.ts`,
    // Pagination-by-default: the universal list query DTO (page/cursor/pageSize
    // + sort). Always emitted — the list endpoint is unconditional.
    listQueryDto: `${moduleGroupDir}/${entityNamePlural}/dto/list-${entityNamePlural}.query.ts`,
    searchUseCase: searchQueryResolved
      ? `${moduleGroupDir}/${entityNamePlural}/use-cases/search-${entityNamePlural}.use-case.ts`
      : null,
    searchController: searchQueryResolved
      ? `${moduleGroupDir}/${entityNamePlural}/${entityName}-search.controller.ts`
      : null,
    declarativeQueries: hasDeclarativeQueries
      ? `${moduleGroupDir}/${entityNamePlural}/use-cases/declarative-queries.ts`
      : null,
    // ADR-041 — the generated `<Entity>ComposedBase` that applies the mixin
    // chain. Emitted only when TWO OR MORE capabilities stack; one capability
    // is wrapped inline in the repository's `extends` clause, and none leaves
    // the repository byte-identical to its pre-CAP-1 shape.
    composedBase: capabilityMixins.length >= 2
      ? `${moduleGroupDir}/${entityNamePlural}/${entityName}.composed-base.ts`
      : null,
    // ADR-033.1 §8 — integration-source module emission for clean-lite-ps. Co-located
    // with the entity feature module under src/modules/<plural>/. Closes #267.
    // #403: routed through moduleGroupDir so a `context:`-tagged entity nests the
    // integration-source module under its context segment (untagged → flat, the
    // same `${srcRoot}/modules/<plural>/…` path as before).
    integrationSourceModule: `${moduleGroupDir}/${entityNamePlural}/${entityName}-integration-source.module.ts`,
    // ADR-033.2's per-entity provider tuples (`<entity>-integration-source.providers.ts`)
    // are removed by RFC-0001 §8 (D4). The surface-scoped typed view
    // (`src/integrations/<surface>/types.generated.ts`) is the single source of
    // provider truth now — see src/cli/shared/adapter-emission-generator.ts.
  };

  // Architecture-specific imports for clean-lite-ps. The integration-source module
  // imports the entity type sibling-style (`./<entity>.entity`) since the
  // module file lives next to the entity file in the same feature folder.
  const clpImports = {
    integrationSourceToEntity: `./${entityName}.entity`,
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
    // Pagination-by-default: list query DTO + schema (re-export of the shared
    // ListQuerySchema). Named per-entity so the controller import is unambiguous.
    listQueryDto: `List${entityNamePluralPascal}QueryDto`,
    listQuerySchema: `List${entityNamePluralPascal}QuerySchema`,
  };

  // Fields for create DTO: exclude id, behavior-managed fields, and FK fields
  const createDtoFields = nonFkFields.filter(
    (f) => !BEHAVIOR_MANAGED_FIELDS.has(f.name)
        && !(hasExternalIdTracking && EXTERNAL_ID_TRACKING_FIELDS.has(f.name)),
  );

  // FK fields from belongs_to for create/output DTOs
  const belongsToFkFields = belongsTo.map((rel) => ({
    camelName: rel.camelField,
    zodChainCreate: rel.nullable ? 'z.string().uuid().nullable().optional()' : 'z.string().uuid()',
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

  // Integration write-surface derivation (#374) — null unless pattern: Integrated.
  // Pass sinkPolicy (#490) so the delete knob and exclude_fields knob are applied
  // at this derivation (repo config) as well as buildSinkInput (sink derivation).
  const sinkPolicy = definition.integration?.sink ?? null;
  const integrationSurface = buildIntegrationSurface(
    patternName,
    nonFkFields,
    belongsTo,
    hasTimestamps,
    eavEnabled,
    hasSoftDelete,
    fields,
    sinkPolicy,
    tenantScoped,
  );

  // ── ADR-041 emission ──────────────────────────────────────────────────────
  //
  // The repository's `extends` clause, by how many capabilities layer:
  //    0  → `Spine<…>`               — byte-identical to the pre-CAP-1 output
  //    1  → `WithX(Spine<…>)`        — inline (ADR-041 §6)
  //   ≥2  → `<Entity>ComposedBase`   — a generated file, for readability
  //
  // The spine expression is built here rather than in the template because the
  // integrated form carries four type arguments over five lines; keeping both
  // forms in one place is what makes "no capability ⇒ no diff" checkable.
  const spineTypeArgs = integrationSurface !== null
    ? [
        classNames.entity,
        `typeof ${entityNamePlural}`,
        `${classNames.entity}IntegrationWrite`,
        `${classNames.entity}IntegrationProjection`,
      ]
    : [classNames.entity, `typeof ${entityNamePlural}`];
  // The integrated spine's four arguments have always been emitted one per
  // line; the two-argument form has always been inline. Both are reproduced
  // byte-for-byte so an entity with no capability sees no diff.
  const spineIsMultiline = integrationSurface !== null;
  // Every renderer below leaves its FIRST line unpadded — the caller has
  // already written the indent (or the `extends ` keyword) — and pads only the
  // continuation lines.
  const renderSpine = (depth) => {
    if (!spineIsMultiline) {
      return `${patternConfigClasses.repositoryBaseClass}<${spineTypeArgs.join(', ')}>`;
    }
    const pad = '  '.repeat(depth);
    const argPad = '  '.repeat(depth + 1);
    return (
      `${patternConfigClasses.repositoryBaseClass}<\n` +
      spineTypeArgs.map((a) => `${argPad}${a}`).join(',\n') +
      `\n${pad}>`
    );
  };
  // Rightmost capability outermost (ADR-041 §6). A chain over a single-line
  // spine stays on one line; over the multi-line integrated spine each layer
  // gets its own indent level, which is the readability ADR-041 §6 asks for
  // when it sends two-or-more capabilities to their own file.
  const renderChain = (outermostFirst, depth) => {
    if (outermostFirst.length === 0) return renderSpine(depth);
    const [head, ...rest] = outermostFirst;
    if (!spineIsMultiline) {
      return `${head.mixin}(${renderChain(rest, depth)})`;
    }
    const inner = renderChain(rest, depth + 1);
    return `${head.mixin}(\n${'  '.repeat(depth + 1)}${inner},\n${'  '.repeat(depth)})`;
  };
  const capabilityChain = renderChain([...capabilityMixins].reverse(), 0);
  const composedBaseClass =
    capabilityMixins.length >= 2 ? `${entityNamePascal}ComposedBase` : null;
  const composedBaseImport = composedBaseClass
    ? `./${entityName}.composed-base`
    : null;
  const repositoryExtendsClause = composedBaseClass ?? capabilityChain;

  // Generation-time collision check (ADR-041 §4). Codegen can only see the
  // vocabularies it generates or that a capability declares; a clash against an
  // opaque spine base still surfaces as a consumer compile error, which ADR-041
  // §4 accepts as irreducible.
  //
  // Only collisions INVOLVING a capability are errors here — the `queries:` ×
  // FK-traversal overlap is pre-existing and resolved by the precedence rule
  // documented in repository.ejs.t, not an undetected clash.
  const compositionCollisions = detectMethodCollisions([
    ...patternBase.capabilities
      .filter((cap) => (cap.forwarderMethods ?? []).length > 0)
      .map((cap) => ({
        source: `capability '${cap.name}'`,
        methods: cap.forwarderMethods ?? [],
        capability: true,
      })),
    {
      source: "the entity's `queries:` block",
      methods: processedQueries.map((q) => q.methodName),
      capability: false,
    },
    {
      source: 'a relationship forwarder',
      methods: [
        ...belongsTo.map((rel) => rel.relationKey),
        ...hasMany.filter((rel) => rel.targetExists).map((rel) => rel.name),
      ],
      capability: false,
    },
  ]);
  if (compositionCollisions.length > 0) {
    throw new Error(
      `[codegen] pattern composition failed for '${entityName}':\n  ` +
      compositionCollisions.map((e) => e.message).join('\n  '),
    );
  }

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
  // ADR-043 §5: use-cases read the acting principal from the ambient
  // RequesterContext (ALS), never from self-asserted request headers.
  const tenantContextImport =
    baseLocals?.tenantContextImport ?? '@shared/base-classes/tenant-context';
  // Pagination contract (pagination-by-default). Package mode → the runtime
  // module `@pattern-stack/codegen/runtime/http/pagination`; vendored / default
  // → the consumer-owned `@shared/http/pagination`. Threaded from prompt.js;
  // unit tests that call buildCleanLitePsLocals directly get the @shared default.
  const paginationImport =
    baseLocals?.paginationImport ?? '@shared/http/pagination';

  return {
    // Clean-Lite-PS identity
    entityName,
    entityNamePascal,
    entityNamePlural,
    entityNamePluralPascal,

    // ADR-043 §6: HTTP surface gate (controller + search controller + wiring)
    clpApiEnabled,

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
    tenantContextImport,
    paginationImport,

    // Pattern — registry-driven (ADR-031)
    patternName,
    hasPatternConfig,
    patternConfig: patternConfigBlock,
    renderPatternConfigLiteral,
    ...patternConfigClasses,

    // Capability composition (ADR-041). `capabilityMixins` is empty for every
    // entity that declares no capability, and then `repositoryExtendsClause` is
    // exactly the string the template used to build inline.
    capabilityMixins,
    capabilityForwarders,
    capabilityConfigImports,
    composedBaseClass,
    composedBaseImport,
    repositoryExtendsClause,
    composedBaseExtendsClause: composedBaseClass ? capabilityChain : null,

    // Integration write-surface (#374) — emitted only for pattern: Integrated. The
    // template hand-emits the integrationConfig literal (live refTable handles) +
    // TIntegrationWrite/TIntegrationProjection from these.
    hasIntegrationSurface: integrationSurface !== null,
    clpIntegrationConfig: integrationSurface?.integrationConfig ?? null,
    clpIntegrationFkResolvers: integrationSurface?.fkResolvers ?? [],
    clpIntegrationWriteFields: integrationSurface?.writeFields ?? [],
    clpIntegrationWriteFkFields: integrationSurface?.writeFkFields ?? [],
    clpIntegrationProjectionFields: integrationSurface?.projectionFields ?? [],
    clpIntegrationParentTableImports: integrationSurface?.parentTableImports ?? [],

    // Behavior flags (also exposed at top level for template use)
    hasTimestamps,
    hasSoftDelete,
    hasUserTracking,
    hasExternalIdTracking,

    // Tenant scoping (ADR-042 / TEN-1)
    tenantScoped,

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


    // #403: bounded-context segment (null when untagged). Drives the
    // module-folder nesting reflected in clpOutputPaths above.
    clpContext: entityContext,

    // Output paths
    clpOutputPaths: outputPaths,

    // Architecture-specific imports (ADR-033.1 §8 — integration-source closes #267)
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
    // A self-referential belongs_to FK requires the `references()` callback
    // to carry a `: AnyPgColumn` return-type annotation; otherwise TypeScript's
    // strict mode flags the table const with TS7022/TS7024 (circular initializer).
    // Surfaced by the cgp-62 relationship-scenario smoke when generating a CRM
    // account with a `parent_account_id` self-FK.
    clpHasSelfFk: belongsTo.some((rel) => rel.isSelfFk) || fieldFeatures.hasSelfFieldFk,
    clpEnumFields,

    // Field-level foreign_key imports (#354) and pgTable extra-config
    // entries: single-column indexes (#355) + composite unique indexes (#356)
    // + the external_id_tracking unique index.
    clpFieldFkImports,
    clpTableConstraints,

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
