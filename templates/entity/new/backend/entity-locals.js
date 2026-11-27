/**
 * backend template locals extension
 *
 * Exports buildBackendLocals(definition, baseLocals) which derives
 * all variables required by the backend template set.
 */

import fs from 'node:fs';
import path from 'node:path';
import pluralizePkg from 'pluralize';
import {
  entityLookupFrom,
  entityModuleNaming,
  relativeModuleDir,
} from '../../../_shared/entity-naming.mjs';
import { junctionFanOutFor, junctionNaming } from '../../../_shared/junction-fan-out.mjs';
import { TABLE_CALLBACK_PARAM as T } from '../../../_shared/table-callback.mjs';
import {
  familyReads,
  inheritanceFor,
  matchColumns,
  resolveEnumField,
} from '../../../_shared/inheritance.mjs';
// The patterns barrel has the side effect of pre-registering the five
// library-shipped patterns (Base / Integrated / Activity / Knowledge /
// Metadata). App-defined patterns are loaded separately in the parent
// prompt.js via loadAppPatterns() against `codegen.config.yaml patterns:`
// globs before this helper runs — we only read the registry here, through
// `resolvePatternComposition`.
import { discriminatorKindsOf, inheritanceBaseOf, inheritsOf, naturalKeyIndexOf } from '../../../../src/schema/inheritance.js';
import { detectMethodCollisions } from '../../../../src/patterns/compose.js';
import { resolvePatternComposition } from '../../../../src/patterns/resolve-composition.js';
import '../../../../src/patterns/library/index.js';
import { deriveEntityApiSurface } from '../../../../src/derived/api/entity.js';
import { arrayElementType, deriveFieldFacts, isArrayType } from '../../../../src/derived/columns/fields.js';
import { columnRendererFor } from '../../../../src/targets/columns.js';
import { constraintRendererFor } from '../../../../src/targets/constraints.js';
import { tokenizePredicate } from '../../../../src/derived/constraints/predicate.js';
import { onDeleteAction } from '../../../../src/derived/constraints/on-delete.js';
import {
  familyConstName,
  familyHelperName,
  dtoFileStem,
  dtoSchemaNames,
  finderName,
  fkFinderName,
  moduleClassName,
  pascalCase,
  relationMethodName,
} from '../../../../src/derived/api/names.js';
import { camelCase, emittedStem } from '../../../../src/config/file-naming.js';
import { resolvedBehaviorNames as resolveBehaviorNames } from '../../../../src/patterns/implied-behaviors.js';
import { foreignKeyColumnNullable } from '../../../../src/schema/field-nullability.js';
import { behaviorWithTimezone } from '../../../../src/schema/field-timestamp.js';
import { resolveTenancy } from '../../../../src/schema/tenancy.js';
import { matchPairsOf } from '../../../../src/schema/inheritance.js';
import { sqlTableName } from '../../../../src/config/table-naming.js';
import { rewriteSharedImport, subsystemsImport } from '../../../../src/config/runtime-mode.mjs';
import { DEFAULT_CODEGEN_CONFIG } from '../../../../src/config/project-config.js';
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
 *     A one-role's column is its `belongsTo` entry's `camelField` — the FK
 *     CAP-2 already derived, not a second derivation. A many-role's junction is
 *     addressed by the one junction naming rule (`junctionNaming`,
 *     `templates/_shared/junction-fan-out.mjs` — table `camelCase(pluralize(via))`,
 *     file `<modules_dir>/<plural>/<via>.entity`, FK columns `<entity>_id`),
 *     which has no YAML override.
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
    modulesDir,
    entityLookup,
  } = ctx;
  const importFrom = (target) => {
    const rel = path.posix.relative(repositoryDir, target);
    return rel.startsWith('.') ? rel : `./${rel}`;
  };

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
      const junction = junctionNaming(def.via, modulesDir);
      const table = junction.tableVar;
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
        importPath: importFrom(junction.entityFile),
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
    const naming = entityModuleNaming(target, modulesDir);
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

/** A spine's comma-separated inherited-method lines, as single names. Exported for unit-testing. */
export function splitMethodList(lines) {
  return (lines ?? []).flatMap((line) =>
    line.split(',').map((m) => m.trim()).filter(Boolean),
  );
}

// `resolvePatternComposition` lives in `src/patterns/resolve-composition.ts` — one function for hygen and the
// CLI's derivation (ADR-046). Re-exported here for the callers that reach it through this module.
export { resolvePatternComposition };

// ============================================================================
// Helper utilities
// ============================================================================

const pluralize = (s) => pluralizePkg.plural(s);

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
  uuid: 'z.guid()',
  date: 'z.coerce.date()',
  datetime: 'z.coerce.date()',
  // jsonb has no schema guarantees and routinely holds arrays, objects, or
  // scalars — z.unknown() preserves that. Use z.record(...) shaping in refine
  // code at the consumer if stricter validation is needed.
  json: 'z.unknown()',
};

/**
 * The Zod schema of a field's VALUE, before nullability/optionality: the enum
 * of its choices or its scalar's schema, wrapped in `z.array()` for an array
 * type. The one place processFields and both DTO chains read it from. Zod is
 * shared by every target (TGT-0): it reads the field's facts, never a target's
 * column text.
 */
function zodValueFor({ type, hasChoices, choices }) {
  const element = hasChoices
    ? `z.enum([${choices.map((c) => `'${c}'`).join(', ')}])`
    : (ZOD_TYPE_MAP[arrayElementType(type)] || 'z.unknown()');
  return isArrayType(type) ? `z.array(${element})` : element;
}

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

/** The Zod checks a field's length bounds add to its write-DTO value (#772). */
export function zodLengthChecks({ minLength, maxLength }) {
  return (minLength != null ? `.min(${minLength})` : '') + (maxLength != null ? `.max(${maxLength})` : '');
}

/**
 * Process entity fields into ProcessedField[]: each field's facts
 * (`deriveFieldFacts`, `src/derived/columns/`), its column as the project's
 * target renders it (`columns`, `src/targets/columns.ts`), and its Zod value.
 * One record per field, the shape every backend template reads (TGT-0).
 *
 * `entityName` (snake_case) namespaces enum-typed fields so two entities that
 * each declare an enum field with the SAME name (e.g. `role`, `status`) don't
 * collide (`enumTypeNames`). `enumResolver` resolves a `choices_of:` field to
 * its owner's enum (RFC-0006 §2.4); `null` where there is no lookup.
 */
export function processFields(fields, { entityName, enumResolver, columns }) {
  if (!columns) throw new Error(`processFields(${entityName}): columns (the target's column renderer) is required.`);
  return deriveFieldFacts(fields, entityName, enumResolver).map((f) => {
    const { drizzleType, drizzleChain, tsType } = columns.render(f);
    return {
      name: f.name,
      camelName: f.camelName,
      type: f.type,
      drizzleType,
      zodType: zodValueFor(f),
      tsType,
      nullable: f.nullable,
      required: f.required,
      hasDefault: f.hasDefault,
      // The declared `default:` value: the create DTO's `.default(…)` prints it (it printed `false` without it).
      default: f.default,
      isPrimaryKey: false,
      drizzleChain,
      choices: f.choices,
      hasChoices: f.hasChoices,
      enumName: f.enumName,
      enumDbName: f.enumDbName,
      // Set when the pgEnum is another entity's (`choices_of:`): imported, not declared.
      enumImport: f.enumImport,
      minLength: f.minLength,
      maxLength: f.maxLength,
    };
  });
}

/**
 * Process has_many relationships into HasManyRelation[].
 *
 * Mirrors processBelongsTo. The `foreign_key` declared on a has_many
 * relationship is the inverse FK living on the *target* entity's table —
 * e.g. `account.relationships.contacts: { foreign_key: account_id }` means
 * contacts.account_id. The method name on AccountRepository would be
 * `findByAccountId`.
 *
 * `renderSet` is the set of entity names the same run renders (`--renderSet`,
 * #815).
 */
function processHasMany(relationships, naming, renderSet = new Set()) {
  if (!relationships) return [];

  const result = [];

  for (const [relName, rel] of Object.entries(relationships)) {
    if (rel.type !== 'has_many') continue;

    const target = rel.target;
    const inverseForeignKey = rel.foreign_key;
    // A has_many whose target has no YAML is simply not wired (soft, as the
    // file check below) — it contributes no import and no composition.
    const resolved = resolveTargetNaming(target, naming, { required: false });
    const isSelfRef = target === naming.entityName;

    // Wired when the target will exist once this run finishes (#815): it is in
    // the run's render set (`--renderSet`), or its entity file is already on
    // disk at the target's OWN module folder (`plural:`, `context:`). The file
    // check is kept, deliberately not a YAML check: a single `entity new
    // x.yaml` regenerating a parent must still wire a target an earlier run
    // generated, and must not import a sibling that has a YAML but has never
    // been generated. A target with no YAML (`resolved` null) is never wired.
    // The stem is the emitted (kebab) one — a snake `${target}.entity.ts` never
    // matched a multi-word target, which silently dropped its composition
    // method (hoops dogfood F7).
    let targetExists = isSelfRef;
    if (!isSelfRef && resolved) {
      targetExists =
        renderSet.has(target) ||
        fs.existsSync(
          path.resolve(resolved.moduleDir, `${emittedStem(target)}.entity.ts`),
        );
    }

    const targetPlural = resolved ? resolved.plural : null;
    result.push({
      name: relName,
      target,
      targetClass: pascalCase(target),
      targetPlural,
      targetImportDir: resolved ? resolved.importDir : null,
      inverseForeignKey,
      inverseForeignKeyCamel: camelCase(inverseForeignKey),
      inverseForeignKeyPascal: pascalCase(inverseForeignKey),
      isSelfRef,
      targetExists,
      importPath: resolved ? `${resolved.importDir}/${emittedStem(target)}.repository` : null,
    });
  }

  return result;
}

/**
 * Resolve a referenced entity's naming from ITS YAML (NAME-0, #630): table
 * export, module folder, and the folder's import path from this entity's own
 * module folder. A self-reference is this entity's own naming.
 *
 * `naming` is `{ entityName, ownNaming, modulesDir, entityLookup }`. With
 * `required`, a target with no entity YAML is a generation error: every
 * caller that passes it emits the target's table unconditionally, and there is
 * nothing else to read that name from. Otherwise it resolves to `null`.
 */
function resolveTargetNaming(target, naming, { required }) {
  const { entityName, ownNaming, modulesDir, entityLookup } = naming;
  let targetNaming;
  if (target === entityName) {
    targetNaming = ownNaming;
  } else {
    const block = entityLookup ? entityLookup(target) : null;
    if (!block) {
      if (!required) return null;
      const why = entityLookup ? entityLookup.missingEntity(target) : 'no entity lookup was supplied';
      throw new Error(
        `[codegen] '${entityName}' references '${target}', which has no entity YAML — ${why}. ` +
          `Its table and module folder are read from that YAML.`,
      );
    }
    targetNaming = entityModuleNaming(block, modulesDir);
  }
  return {
    plural: targetNaming.plural,
    moduleDir: targetNaming.moduleDir,
    importDir: relativeModuleDir(ownNaming.moduleDir, targetNaming.moduleDir),
  };
}

/**
 * Process belongs_to relationships into BelongsToRelation[]
 *
 * `fields` is the raw `fields:` map (snake_case keyed). When the FK column is
 * ALSO declared as a field (e.g. `conversation_id: { type: uuid, required:
 * true, index: true }`), the belongs_to column must inherit that field's
 * `required`/`nullable` (→ `.notNull()`) and `index: true` (→ a single-column
 * index). The FK field's
 * `unique: true` is NOT carried on the rel: `fieldUniqueEntries` reads the raw
 * `fields:` map (#511). The relationship moves the column out of `processedFields`, so
 * those declarations would otherwise be silently dropped. An explicit
 * `nullable:` on the relationship (or role) outranks the field declaration
 * (`foreignKeyColumnNullable`).
 */
function processBelongsTo(relationships, naming, fields = {}) {
  if (!relationships) return [];

  const result = [];

  for (const [relName, rel] of Object.entries(relationships)) {
    if (rel.type !== 'belongs_to') continue;

    const target = rel.target;
    const field = rel.foreign_key;
    // Precedence: explicit relationship `nullable:` → the FK field's own
    // declaration → nullable. One rule, shared with the parser and REL-1.
    const fieldDef = fields[field];
    const nullable = foreignKeyColumnNullable(rel.nullable, fieldDef);
    // Carry the field's `index: true` so the table-constraints builder can emit
    // the same single-column index a non-FK field would get.
    //
    // CAP-2: a role-derived FK is indexed by DEFAULT — a role edge exists to be
    // traversed. Declaring the FK column in `fields:` is still the way to say
    // otherwise, so an explicit field declaration wins in both directions.
    const hasIndex = fieldDef ? fieldDef.index === true : rel.index === true;
    const resolved = resolveTargetNaming(target, naming, { required: true });
    const relatedPlural = resolved.plural;
    const isSelfFk = target === naming.entityName;

    // on_delete defaults to 'restrict' per ADR-021
    const onDeleteYaml = rel.on_delete ?? 'restrict';
    const onDelete = onDeleteAction(onDeleteYaml);

    // Relation key — names this edge's per-relationship members (the
    // service's parent-fetch method, the Integrated write key
    // `<relationKey>ExternalId`). For self-FKs derive from the FK column name
    // (parent_account_id → parentAccount) to avoid colliding with the table's
    // own snake_case name. Otherwise it is the RELATIONSHIP name, verbatim —
    // as a has_many's member is — never the target's: two belongs_to onto one
    // target (`home_team` / `away_team` → `nba_team`) are two edges, and
    // keying by target gave them one method and one write key between them
    // (#731). Casing is #494 / #697's, not changed here. A role names its own
    // edge (CAP-2), so `host: contact` and `organizer: contact` stay two. The
    // rule is the derivation's — the service method's name (ADR-046).
    const relationKey = relationMethodName({
      cardinality: 'one',
      name: relName,
      role: rel.role,
      foreignKey: field,
      isSelf: isSelfFk,
    });

    result.push({
      // The YAML key — joins this entry to the derived method its origin names.
      name: relName,
      field,
      role: rel.role ?? null,
      camelField: camelCase(field),
      relatedEntity: target,
      relatedEntityPascal: pascalCase(target),
      relatedTable: relatedPlural,
      relatedPlural,
      relatedImportDir: resolved.importDir,
      nullable,
      hasIndex,
      importPath: `${resolved.importDir}/${emittedStem(target)}.entity`,
      relationKey,
      isSelfFk,
      onDelete,
      onDeleteYaml,
      // `match:` (RFC-0006 §2.4): `[local, targetColumn]` pairs. A relationship
      // that has one is ONE composite FK (emitted in the extra-config list), so
      // its column carries no single-column `.references()`.
      match: matchPairsOf(rel).length > 0 ? matchPairsOf(rel) : null,
      relName,
    });
  }

  return result;
}

/**
 * The other entities this service needs a repository for (#632), deduped by
 * target entity across every edge that composes one: non-self `belongs_to`
 * (parent fetch) and wired non-self `has_many` (child list), in that order.
 * `service.ejs.t` imports + injects each once; `module.ejs.t` imports each one's
 * home module once (ADR-002, revision 2026-11-15). The per-relationship methods still iterate
 * `belongsTo` / `existingHasMany`; they address the repository by the
 * same `property`.
 *
 * @param {object[]} belongsTo          belongsTo entries
 * @param {object[]} existingHasMany    existingHasMany entries
 */
function collectRepositoryDeps(belongsTo, existingHasMany) {
  const deps = new Map();
  const add = (entity, importDir) => {
    if (deps.has(entity)) return;
    const className = pascalCase(entity);
    deps.set(entity, {
      entity,
      // The emitted file stem for the target's files (NAME-2): kebab-case,
      // while `entity` stays the YAML/snake name used for lookups + classes.
      fileStem: emittedStem(entity),
      entityClass: className,
      repositoryClass: `${className}Repository`,
      property: `${camelCase(entity)}Repo`,
      importDir,
    });
  };
  for (const rel of belongsTo) if (!rel.isSelfFk) add(rel.relatedEntity, rel.relatedImportDir);
  for (const rel of existingHasMany) if (!rel.isSelfRef) add(rel.target, rel.targetImportDir);
  return [...deps.values()];
}

/**
 * Field-level `foreign_key:` + `index:` emission (#354, #355).
 *
 * Distinct from `relationships:`-driven belongs_to FKs (processBelongsTo),
 * which own their own column + import. This handles features declared
 * directly on a column field:
 *
 *   - `foreign_key: <table>.<column>` → append
 *     `.references((): AnyPgColumn => <table>.<column>)` to the column's Drizzle
 *     chain (every FK callback is annotated — #631, see `hasFk`)
 *     and record the cross-module import. The table segment is the Drizzle table
 *     export name (plural, e.g. `conversations`); the import comes from the
 *     entity whose YAML declares that plural, at its own folder (NAME-0).
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
 * later rendered via processedFields). Returns the imports + index
 * expressions the template needs.
 *
 * @param {object[]} renderedFields  the fields actually emitted as columns
 *                                   (nonFkFields — belongs_to FK columns excluded)
 * @param {object}   fields          raw field map keyed by snake_case name
 * @param {object}   naming          `resolveTargetNaming` context (this entity + the lookup)
 * @param {Set<string>|string[]} [ownedTables] table names codegen generates; a
 *   `foreign_key` outside this set is host-owned and emits no DB-level FK.
 *   Absent → every target is treated as owned (the pre-#636 behaviour), which
 *   only happens when a caller builds locals without prompt.js.
 * @param {Set<string>} [suppressedIndexNames] names of fields whose `index: true`
 *   is suppressed because another index already serves them: their unique index
 *   (#511) leads with the column, or they are the adopted tenant column (the
 *   tenant index is that index). Absent or empty → suppress nothing: an extra index is harmless, a
 *   silently dropped one is not.
 * @param {object}   constraints     the target's constraint renderer (`constraintRendererFor`, TGT-1): writes the
 *   `.references(…)` suffix and the index entry from their facts. Required.
 */
export function processFieldFeatures(renderedFields, fields, naming, ownedTables, suppressedIndexNames, constraints) {
  if (!constraints) {
    throw new Error(`processFieldFeatures(${naming?.entityName}): the target's constraint renderer is required (TGT-1).`);
  }
  // TABLE-0: a `foreign_key: <table>.<column>` names a SQL TABLE, and index
  // names are SQL identifiers — both read `entityTableName`. The `.references()`
  // callback and the import name the target's Drizzle EXPORT (its `plural`),
  // which differs from the table once `table` / a prefix is in play.
  const entityNamePlural = naming.ownNaming.plural;
  const entityTableName = naming.entityTableName;
  const owned = ownedTables === undefined
    ? null
    : (ownedTables instanceof Set ? ownedTables : new Set(ownedTables));
  const fkImports = [];
  const indexExpressions = [];
  const seenImports = new Set();
  let hasFieldFk = false;

  for (const pf of renderedFields) {
    const field = fields[pf.name];
    if (!field) continue;

    // --- foreign_key (#354) ---
    if (typeof field.foreign_key === 'string' && field.foreign_key.includes('.')) {
      const [relatedTable, fkColumn] = field.foreign_key.split('.');
      const isSelfFk = relatedTable === entityTableName;
      // #636 — a target codegen does not generate is host-owned: emit the
      // column with no DB-level FK and no import rather than an import that
      // cannot resolve. Self-FKs are owned by definition.
      const isOwned = isSelfFk || owned === null || owned.has(relatedTable);
      if (isOwned) {
        // The segment names a TABLE: the entity that owns it is the one whose
        // SQL table name it is (NAME-0, TABLE-0) — not `singularize(table)`.
        let relatedExport = entityNamePlural;
        if (!isSelfFk) {
          const owner = naming.entityLookup?.byTable
            ? naming.entityLookup.byTable(relatedTable)
            : null;
          if (!owner) {
            const why = naming.entityLookup?.missingTable
              ? naming.entityLookup.missingTable(relatedTable)
              : 'no entity lookup was supplied';
            throw new Error(
              `[codegen] '${naming.entityName}' field '${pf.name}' foreign_key: '${field.foreign_key}' — ` +
                `the table '${relatedTable}' is not owned by any entity YAML (${why}). ` +
                `Either declare that entity (a YAML whose SQL table is '${relatedTable}'), or drop the ` +
                `column-level \`foreign_key:\` and keep '${pf.name}' a plain column; codegen ` +
                `cannot import a table it does not generate.`,
            );
          }
          const resolved = resolveTargetNaming(owner.name, naming, { required: true });
          relatedExport = resolved.plural;
          if (!seenImports.has(relatedExport)) {
            seenImports.add(relatedExport);
            fkImports.push({
              relatedTable: relatedExport,
              importPath: `${resolved.importDir}/${emittedStem(owner.name)}.entity`,
            });
          }
        }
        // Every FK callback is annotated (#631): see `hasFk`. The suffix is the target's text (TGT-1).
        pf.drizzleChain += constraints.columnReference({ targetExport: relatedExport, targetProp: fkColumn });
        hasFieldFk = true;
      }
      // else: host-owned target — plain column, no FK, no import. `index: true`
      // below still applies; a host-owned reference is usually worth indexing.
    }

    // --- index: true (#355) ---
    if (field.index === true && !(suppressedIndexNames && suppressedIndexNames.has(pf.name))) {
      const name = `${entityTableName}_${pf.name}_idx`;
      indexExpressions.push({
        comment: null,
        expr: constraints.index({ name, props: [pf.camelName] }, T),
        name,
        builder: 'index',
        source: `field '${pf.name}' (index: true)`,
      });
    }
  }

  return { fkImports, indexExpressions, hasFieldFk };
}

/**
 * Columns of the rendered `pgTable`, as `{ column, prop }` (#784). Built from
 * exactly the inputs the entity template renders (`id`; belongs_to FK columns;
 * non-FK fields; the external_id_tracking, tenant and timestamp/soft-delete
 * columns); a unit test pins it to the rendered column block.
 */
function entityTableColumns({
  belongsTo,
  nonFkFields,
  hasExternalIdTracking,
  tenancy,
  hasTimestamps,
  hasSoftDelete,
  extraColumns = [],
}) {
  const cols = [{ column: 'id', prop: 'id' }, ...extraColumns];
  for (const rel of belongsTo) cols.push({ column: rel.field, prop: rel.camelField });
  for (const f of nonFkFields) cols.push({ column: f.name, prop: f.camelName });
  if (hasExternalIdTracking) {
    cols.push(
      { column: 'external_id', prop: 'externalId' },
      { column: 'provider', prop: 'provider' },
      { column: 'provider_metadata', prop: 'providerMetadata' },
    );
  }
  // An ADOPTED tenant column (#791) is already in the list, as its field or
  // belongs_to; only an emitted one is added here.
  if (tenancy && !tenancy.adopted) cols.push({ column: tenancy.column, prop: tenancy.prop });
  if (hasTimestamps) {
    cols.push({ column: 'created_at', prop: 'createdAt' }, { column: 'updated_at', prop: 'updatedAt' });
  }
  if (hasSoftDelete) cols.push({ column: 'deleted_at', prop: 'deletedAt' });
  return cols;
}

/**
 * Unique constraint emission (#356, #511, #784). The input is every unique an
 * entity declares: field-level `unique: true` lowered by `fieldUniqueEntries`
 * (#511), then the top-level `unique_indexes:` entries. Each entry is
 * `{ fields, name?, where?, nulls_not_distinct?, source }`.
 *
 *   partial = where is set
 *   nnd     = partial ? false : (nulls_not_distinct ?? tenantScoped)
 *   cols    = tenantScoped ? [<tenant column>, ...fields] : fields
 *   name    = name ?? `<table>_${cols.join('_')}_uniq`
 *
 *   partial -> uniqueIndex(name).on(cols).where(sql`...`)
 *   nnd     -> unique(name).on(cols).nullsNotDistinct()
 *   else    -> uniqueIndex(name).on(cols)
 *
 * Postgres treats NULLs in a unique index as distinct, so a tenant-prefixed
 * plain index never deduplicates the (first-class) null-tenant partition
 * (ADR-042 §3); NULLS NOT DISTINCT does. A partial index cannot be NND on
 * drizzle-orm 1.0.0-rc.4, so a partial entry does not. An author `name` is kept
 * verbatim. Generation errors: C1 (unknown column), C2 (the tenant column
 * listed, or a repeated field), and the `where:` scanner errors
 * (`tokenizePredicate`). The rules above are decided here, as facts; the builder and its text are the target's
 * (`constraints.unique`, TGT-1).
 *
 * `tenancy` is `resolveTenancy`'s result (#791) — `null` when the entity is not
 * tenant_scoped; its `column` is the prefix (`tenant_id` by default).
 */
function processUniqueIndexes(
  entries,
  { entityName, tableName, tenancy = null, tableColumns, constraints },
) {
  const tenantScoped = tenancy !== null;
  if (!Array.isArray(entries)) return [];
  const propByColumn = new Map(tableColumns.map((c) => [c.column, c.prop]));
  const columnList = tableColumns.map((c) => c.column).join(', ');
  const lowerColumns = new Map(tableColumns.map((c) => [c.column.toLowerCase(), c.prop]));

  return entries.map((ui) => {
    const label = `[codegen] '${entityName}' ${ui.source}`;
    const seen = new Set();
    for (const f of ui.fields) {
      if (tenantScoped && f === tenancy.column) {
        throw new Error(`${label}: '${f}' must not be listed in fields — it is the tenant column, and a tenant_scoped entity prefixes it automatically.`);
      }
      if (seen.has(f)) throw new Error(`${label}: field '${f}' is listed twice.`);
      seen.add(f);
      if (!propByColumn.has(f)) {
        throw new Error(`${label}: '${f}' is not a column of '${tableName}'. Columns: ${columnList}.`);
      }
    }

    const partial = ui.where !== undefined;
    const cols = tenantScoped ? [tenancy.column, ...ui.fields] : ui.fields;
    const name = ui.name || `${tableName}_${cols.join('_')}_uniq`;
    let where = null;
    if (partial) {
      try {
        where = tokenizePredicate(ui.where, lowerColumns);
      } catch (err) {
        throw new Error(`${label} where: ${err.message}`);
      }
    }
    // The facts; the builder, its text and the pair's note on the NULL tenant are the target's (TGT-1).
    const { expr, builder, comment } = constraints.unique(
      {
        name,
        props: cols.map((c) => propByColumn.get(c)),
        where,
        // A partial unique is never NULLS NOT DISTINCT: the generator's rule (drizzle rc.4 can't write one), decided
        // here so the fact says what the database enforces.
        nullsNotDistinct: partial ? false : (ui.nulls_not_distinct ?? tenantScoped),
        referenced: false,
        tenantScoped,
      },
      T,
    );
    return { name, comment, expr, builder, partial, columns: cols, source: ui.source };
  });
}

/** Postgres keeps 63 bytes of an identifier and truncates the rest without a word. */
export const PG_IDENTIFIER_MAX_BYTES = 63;

/**
 * C3, C4 (#784) and C5: every name in the extra-config callback is distinct and at most
 * 63 bytes (C5; explicit FK names are #921's), and no
 * two non-partial uniques cover the same column set. Partial entries are exempt
 * from C4 — two partial entries over the same columns with different
 * predicates are the documented use.
 */
export function assertDistinctConstraints(tableConstraints, entityName) {
  const names = new Map();
  const colSets = new Map();
  for (const c of tableConstraints) {
    // Two names that differ only after byte 63 are one name to Postgres: a silent collision (or a
    // constraint the author cannot find by the name they read). Only the names the entity table's extra-config
    // callback declares pass through here; a single-column `.references()` FK is named by Drizzle and a
    // junction / relationship table never calls this (a known gap, filed for a decision).
    if (Buffer.byteLength(c.name) > PG_IDENTIFIER_MAX_BYTES) {
      throw new Error(
        `[codegen] '${entityName}': the name '${c.name}' (${c.source}) is ${Buffer.byteLength(c.name)} bytes; ` +
          `Postgres keeps ${PG_IDENTIFIER_MAX_BYTES} and would truncate it. A name starts with the SQL table ` +
          `name, so shorten that with \`entity.table:\` (TABLE-0), or rename the entity or relationship.`,
      );
    }
    if (names.has(c.name)) {
      throw new Error(
        `[codegen] '${entityName}': constraint name '${c.name}' is used by both ${names.get(c.name)} and ${c.source}.`,
      );
    }
    names.set(c.name, c.source);
    if ((c.builder === 'unique' || c.builder === 'uniqueIndex') && !c.partial) {
      const key = [...c.columns].sort().join(',');
      if (colSets.has(key)) {
        throw new Error(
          `[codegen] '${entityName}': ${colSets.get(key)} and ${c.source} declare the same unique over (${c.columns.join(', ')}). Declare it once.`,
        );
      }
      colSets.set(key, c.source);
    }
  }
}

/**
 * Lower each raw `fields:` entry with `unique: true` into a single-field entry
 * for `processUniqueIndexes` (#511), in declaration order. `id` is skipped (the
 * primary key is unique by definition). Reads the raw map so a `belongs_to` FK
 * column declared in `fields:` is covered too.
 */
function fieldUniqueEntries(fields, tenancy = null) {
  return Object.entries(fields || {})
    .filter(([name, def]) => name !== 'id' && def && def.unique === true)
    .map(([name]) => ({
      // `unique: true` on the tenant column means one row per tenant: the
      // builder prefixes the tenant column itself, so the entry lists no field
      // and lowers to `unique(<tenant column>)`.
      fields: tenancy !== null && name === tenancy.column ? [] : [name],
      source: `field '${name}' (unique: true)`,
    }));
}

/**
 * Collect drizzle imports needed for entity fields
 */
function collectDrizzleImports(columns, processedFields, belongsTo, hasTimestamps, hasSoftDelete, hasExternalIdTracking, extraImports = []) {
  const imports = new Set(['pgTable', 'uuid']);

  for (const field of processedFields) {
    if (field.drizzleType === 'enum') {
      // An enum column calls a `pgEnum` that lives in the entity's `.enums` leaf
      // module (or the owner's, for `choices_of:`); this file imports it and
      // needs no `pgEnum` import of its own.
      continue;
    }
    // The builder's import is the target's (TGT-0, ADR-047 §5): never a map read here.
    const importName = columns.importFor(field.drizzleType);
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
  }

  // Caller-supplied extras: the pg-core builders the extra-config callback
  // actually calls (`index`, `uniqueIndex`, `unique`), derived by use (#784) —
  // see processFieldFeatures / processUniqueIndexes.
  for (const extra of extraImports) {
    imports.add(extra);
  }

  return Array.from(imports).sort();
}

/**
 * Whether the field's create chain fills a value when the field is omitted (`.default(…)`). Today: a boolean with a
 * YAML `default:`. The one owner of that rule: the create chain applies it, and the update DTO overrides exactly these
 * fields (ZOD-1a), because an update built as `Create.partial()` would carry the default along. On Zod 4 an
 * `.optional()` around a `.default()` applies it, so a PATCH that omits the field would reset it.
 */
function createChainAppliesDefault(field) {
  return field.type === 'boolean' && field.hasDefault;
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
  let base = zodValueFor({ type, hasChoices, choices });
  // #772: the write contract carries the field's length bounds (the update DTO
  // is the create schema's `.partial()`, so it inherits them). Reads are not
  // re-checked.
  base += zodLengthChecks(field);

  if (createChainAppliesDefault(field)) {
    // `.default()` already makes the input optional in Zod.
    base += `.default(${field.default ?? false})`;
    return base;
  }

  if (nullable) base += '.nullable()';
  if (!required) base += '.optional()';
  return base;
}

/**
 * Derive Zod chain for a field in update DTO context: the create chain made optional, without its default (ZOD-1a).
 * It accepts exactly what `Create.partial()` accepts for the field, and an omitted field is left as it is.
 */
function zodChainForUpdate(field) {
  let base = zodValueFor({ type: field.type, hasChoices: field.hasChoices, choices: field.choices });
  base += zodLengthChecks(field);
  // The create chain does not add `.nullable()` when it applies a default; neither does its update.
  if (field.nullable && !createChainAppliesDefault(field)) base += '.nullable()';
  return base + '.optional()';
}

/**
 * Derive Zod chain for a field in output DTO context
 */
function zodChainForOutput(field) {
  const { type, nullable, hasChoices, choices } = field;
  const base = zodValueFor({ type, hasChoices, choices });
  return nullable ? base + '.nullable()' : base;
}

// ============================================================================
// Query processing
// ============================================================================

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

    let returnType;
    if (isUnique) {
      returnType = `${entityNamePascal} | null`;
    } else if (selectFields.length > 0) {
      const camelFields = selectFields.map((f) => camelCase(f));
      returnType = selectFields.length === 1
        ? `${fieldTypeMap[selectFields[0]] || fieldTypeMap[camelFields[0]] || 'string'}[]`
        : `globalThis.Pick<${entityNamePascal}, ${camelFields.map((f) => `'${f}'`).join(' | ')}>[]`;
    } else {
      returnType = `${entityNamePascal}[]`;
    }

    return {
      by: byFields,
      unique: isUnique,
      select: selectFields,
      order: q.order ?? null,
      limit: q.limit ?? null,
      via: viaTable,
      returnType,
      params,
      isUnique,
      orderBy,
      orderDirection,
      viaTable,
      viaTableCamel: viaTable ? camelCase(viaTable) : null,
      selectFields: selectFields.map((f) => camelCase(f)),
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
 *   - A `SearchXsUseCase` class that ANDs the filters (and the optional
 *     ilike search) into a `where` and pages through the list use case, so
 *     search returns the list's own `Page<T>` (#744).
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

  return {
    filters: resolvedFilters,
    searchField,
    searchFieldCamel: searchField ? camelCase(searchField) : null,
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
 * @param {object[]} belongsTo      belongsTo entries
 * @param {boolean} hasTimestamps
 * @param {boolean} eavEnabled
 * @param {boolean} hasSoftDelete
 * @param {object} [sinkPolicy]       integration.sink knobs {delete?, exclude_fields?}
 * @param {object|null} [tenancy]    `resolveTenancy`'s result (ADR-042, #791) —
 *   prefixes the ON CONFLICT target with the tenant column, and keeps an
 *   ADOPTED tenant column (a field or a belongs_to) out of the write surface:
 *   the runtime stamps it, and the upsert `set` must never rewrite it (#715).
 */
export function buildIntegrationSurface(patternName, processedFields, belongsTo, hasTimestamps, eavEnabled, hasSoftDelete, sinkPolicy, tenancy = null) {
  if (patternName !== 'Integrated') return null;
  const tenantProp = tenancy ? tenancy.prop : null;

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
    .filter((f) => !excludeSet.has(f.name) && f.camelName !== tenantProp)
    .map((f) => f.camelName);

  // FK resolvers — one per belongs_to. writeKey = `${relationKey}ExternalId`
  // (Decision 4). refTable is the string 'self' for self-FKs, else the parent
  // table var name (emitted as a live identifier by the template).
  const fkResolvers = belongsTo.filter((rel) => rel.camelField !== tenantProp).map((rel) => ({
    column: rel.camelField,
    writeKey: `${rel.relationKey}ExternalId`,
    refTable: rel.isSelfFk ? 'self' : rel.relatedTable,
    isSelfFk: rel.isSelfFk,
    nullable: rel.nullable,
    // Strict resolution (throw on unresolved parent → failed item) when the FK
    // COLUMN is NOT NULL — writing null there would fail the insert anyway;
    // opportunistic null otherwise. `rel.nullable` is the column's resolved
    // nullability (`foreignKeyColumnNullable`). Nullable FKs (e.g. self-FK
    // hierarchies) stay opportunistic. (#374, #613)
    strict: !rel.nullable,
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
    // A tenant-scoped entity upserts on (<tenant column>, provider, external_id) —
    // the generated config states it, so the runtime never has to introspect
    // the table to find out (charter I1). Matches the emitted `unique(...)`
    // constraint above.
    conflictTarget: tenantProp
      ? [tenantProp, 'provider', 'externalId']
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
    .filter((f) => !excludeSet.has(f.name) && f.camelName !== tenantProp)
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
 * The behaviors an entity HAS: those it declares plus those its pattern(s) imply (ADR-031), explicit first. The ONE
 * derivation for an entity's own behaviors and for its base's (`familyReads`, a child's `baseScope`). The relations
 * emitter's `behaviorNames` (`src/emitters/relations/build-graph.ts`) states the same rule with the throwing
 * `requireImpliedBehaviors`, deliberately: a manifest that silently dropped an unregistered pattern's behavior would
 * narrow a scope, where a template call has registered its patterns already.
 */
function resolvedBehaviorNames(def) {
  return resolveBehaviorNames(def.behaviors ?? [], def.entity);
}

/**
 * Build backend template locals from entity definition and base locals
 *
 * @param {object} definition - Parsed entity YAML
 * @param {object} baseLocals - Locals from main prompt.js
 * @returns {object} Merged locals with all backend variables
 */
export function buildBackendLocals(definition, baseLocals) {
  const entity = definition.entity;
  const fields = definition.fields || {};
  const relationships = definition.relationships || {};
  const behaviors = definition.behaviors || [];
  const queriesBlock = definition.queries || null;
  // TGT-0: the project's data-access target renders every field column
  // (`src/targets/columns.ts`). Required: prompt.js reads `target` from the
  // parsed config, whose schema owns the default (ADR-047).
  const columns = columnRendererFor(baseLocals.target, `buildBackendLocals(${entity.name})`);
  // TGT-1: and its constraints (`src/targets/constraints.ts`).
  const constraints = constraintRendererFor(baseLocals.target, `buildBackendLocals(${entity.name})`);
  // ADR-043 §6 `api: false` and REL-2 §2.5's typed include are decided once, in
  // the derivation (`apiEnabled` / `hasTypedInclude`, `src/derived/api/
  // entity.ts`); the templates read its answers as `apiSurface.http.enabled` /
  // `apiSurface.repository.typedInclude`.

  // The module tree's root: the resolved `paths.modules_dir` (PATH-1, #645) —
  // prompt.js threads BASE_PATHS.modulesDir here. Callers that build locals by
  // hand (unit tests) get the schema's one default (PATH-0, #642).
  const modulesDir = baseLocals.modulesDir || DEFAULT_CODEGEN_CONFIG.paths.modules_dir;

  const entityName = entity.name;
  const entityNamePascal = pascalCase(entityName);
  // One naming rule for this entity and for any entity that references it
  // (`entityModuleNaming`, `src/config/module-tree.ts`).
  const ownNaming = entityModuleNaming(entity, modulesDir);
  // Every OTHER entity this one references is named from its own YAML through
  // the same function (NAME-0) — `resolveTargetNaming` reads this context.
  const entityLookup = baseLocals?.entityLookup ?? null;
  // TABLE-0: the SQL table name — the `pgTable('…')` argument and the stem of
  // every index / constraint name. One rule (`src/config/table-naming.ts`);
  // everything that is TypeScript (the export, `db.query` key, folder, classes)
  // stays on `ownNaming.plural`. `baseLocals.tablePrefix` is the project's
  // `tables.prefix` that prompt.js reads from the config; absent (locals built
  // by hand in a unit test) means the schema default.
  const projectTablePrefix = baseLocals.tablePrefix ?? DEFAULT_CODEGEN_CONFIG.tables.prefix;
  const projectTenancyColumn = baseLocals.tenancyColumn ?? DEFAULT_CODEGEN_CONFIG.tenancy.column;
  const entityTableName = sqlTableName(entity, projectTablePrefix);
  const targetNaming = { entityName, ownNaming, entityTableName, modulesDir, entityLookup };
  const entityNamePlural = ownNaming.plural;
  // NAME-2: the emitted file stems. `entityName` / `entityNamePlural` stay the
  // YAML snake_case names — they are the class-name and DB-identifier source.
  const entityFileStem = emittedStem(entityName);
  const entityPluralFileStem = emittedStem(entityNamePlural);
  const entityNamePluralPascal = pascalCase(entityNamePlural);

  // #403: bounded-context folder grouping. `entity.context:` nests this
  // entity's module folder under that segment so same-context entities group
  // together (`<modules>/<context>/<plural>/`); no context → flat
  // (`<modules>/<plural>/`, byte-identical to pre-#403). Emit-folder-only —
  // every intra-module import is folder-relative and therefore unaffected, and
  // the generated barrel recomputes its import paths from the full file paths
  // below. The module-folder base used by every outputPaths entry:
  const entityContext = entity.context || null;
  const moduleDir = ownNaming.moduleDir;

  // REL-2 (#587): import specifiers for the two whole-set generated files the
  // emitted repository and controller depend on — the relation manifest and the
  // HTTP include allowlist. Both are relative to this entity's module folder
  // (`<modules>/[<context>/]<plural>/`), so a `context:`-tagged entity gets one
  // more `../` without anything else changing.
  //
  // The generated directory comes from `paths.generated` via prompt.js, the same
  // value the emitters write into. A hard-coded `src/generated` here would break
  // every project that moves it (#612 is the equivalent bug in the init scaffold).
  const generatedDirRel = baseLocals.generatedDir || 'src/generated';
  const relativeFrom = (fromDir, target) => {
    const spec = path.posix.relative(
      path.posix.normalize(fromDir),
      path.posix.normalize(target),
    );
    return spec.startsWith('.') ? spec : `./${spec}`;
  };
  const relativeFromModule = (target) => relativeFrom(moduleDir, target);
  // One value for the folder the use cases are written into: the `outputPaths`
  // entries and the specifier computed from it (`typedEventBusImport`) agree.
  const useCasesDir = `${moduleDir}/use-cases`;
  const relationsImport = relativeFromModule(`${generatedDirRel}/relations`);
  const apiIncludesImport = relativeFromModule(`${generatedDirRel}/api-includes`);


  // EAV (ADR-13) — when true, emit paired reads + transactional compound
  // writes. Consumer must provide `@shared/eav-helpers` and `FieldValueService`.
  const eavEnabled = definition.eav === true;
  // The field-value entity that owns `FieldValueService` / its module is named
  // from ITS YAML (#647, NAME-0) — `plural:` and `context:` place its folder,
  // never a hand-built '../field_values/'.
  const eavFieldValueNaming = eavEnabled
    ? resolveTargetNaming('field_value', targetNaming, { required: true })
    : null;
  const eavFieldValueImportDir = eavFieldValueNaming ? eavFieldValueNaming.importDir : null;
  // The create/update use cases live one folder down (`<moduleDir>/use-cases/`,
  // outputPaths below); their specifier is computed from that folder, not by
  // prefixing `../` onto the module-level one.
  const eavFieldValueUseCaseImportDir = eavFieldValueNaming
    ? relativeModuleDir(useCasesDir, eavFieldValueNaming.moduleDir)
    : null;
  const eavFieldValuePlural = eavFieldValueNaming ? eavFieldValueNaming.plural : null;
  const eavFieldValueModulePascal = eavFieldValuePlural ? pascalCase(eavFieldValuePlural) : null;
  // NAME-2: the emitted file stem for the EAV value-table module.
  const eavFieldValuePluralStem = eavFieldValuePlural ? emittedStem(eavFieldValuePlural) : null;
  // NAME-2: the field-value entity's own file stem. Its name is the fixed
  // `field_value`; only its FOLDER comes from its YAML (#647).
  const eavFieldValueStem = eavEnabled ? emittedStem('field_value') : null;

  // EAV value-table shape (task #23) — when true, this entity IS the value
  // table. Templates emit compound methods (upsertFieldsTransactional,
  // findMergedByEntity) on the service, upsertCurrentValues on the repo,
  // and auto-wire the paired field-definitions module for DI.
  const eavValueTable = definition.eav_value_table === true;
  const eavDefinitionEntity = eavValueTable
    ? (definition.eav_definition_table || null)
    : null;
  const eavDefinitionNaming = eavDefinitionEntity
    ? resolveTargetNaming(eavDefinitionEntity, targetNaming, { required: true })
    : null;
  const eavDefinitionEntityPlural = eavDefinitionNaming ? eavDefinitionNaming.plural : null;
  const eavDefinitionImportDir = eavDefinitionNaming ? eavDefinitionNaming.importDir : null;
  const eavDefinitionPascal = eavDefinitionEntity
    ? pascalCase(eavDefinitionEntity)
    : null;
  // NAME-2: emitted file stems for the EAV definition entity's files.
  const eavDefinitionEntityStem = eavDefinitionEntity ? emittedStem(eavDefinitionEntity) : null;
  const eavDefinitionEntityPluralStem = eavDefinitionEntityPlural
    ? emittedStem(eavDefinitionEntityPlural)
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
  // #814: the TypedEventBus CLASS the write use cases inject. The package barrel
  // exports the token only (its own class is typed to the package's event
  // union), so in package mode the class is the project's generated bus, by a
  // path relative to the use-case folder. It depends on the module folder
  // (`context:`, `paths.modules_dir`) and `paths.generated`, so it cannot live
  // in the mode-keyed `runtimeImportLocals` table. Vendored: the vendored
  // barrel exports both, and the templates keep their single combined line.
  const typedEventBusImport =
    runtimeMode === 'vendored'
      ? subsystemsImport('vendored', 'events')
      : relativeFrom(useCasesDir, `${generatedDirRel}/events/bus`);
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
  for (const cap of patternBase.capabilities) {
    const capConfigBlock =
      (definition.config && definition.config[cap.name]) ||
      (definition.entity && definition.entity.config && definition.entity.config[cap.name]) ||
      null;
    const hasCapConfig =
      capConfigBlock != null &&
      typeof capConfigBlock === 'object' &&
      Object.keys(capConfigBlock).length > 0;
    // A `config:` block is only meaningful against a `configSchema` — without
    // one the mixin declares no `<cap>Config` property for the emitted
    // `override` to fill, and nothing validates the block (#688).
    if (hasCapConfig && !cap.configSchema) {
      throw new Error(
        `[codegen] entity '${entityName}' supplies a \`config: { ${cap.name}: ... }\` block, but ` +
        `capability '${cap.name}' declares no \`configSchema\` — it takes no config. ` +
        `Remove the block, or give the capability a configSchema (and its mixin the config property).`,
      );
    }
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
  }

  // Process entity fields. Pass the entity name so enum fields namespace their
  // pg type + exported const by entity (prevents same-named enum collisions
  // across entities — TS2308 / duplicate CREATE TYPE).
  const processedFields = processFields(fields, {
    entityName,
    enumResolver: (fieldName, field) =>
      resolveEnumField({ lookup: entityLookup, modulesDir, fromNaming: ownNaming, entityName, fieldName, field }),
    columns,
  });

  // Behavior flags (re-read from behaviors array for backend use).
  //
  // Fold in the resolved pattern's `impliedBehaviors` (ADR-031): an entity
  // declaring e.g. `pattern: Integrated` need not re-declare the
  // `external_id_tracking` behavior — the pattern contributes it. Deduped
  // with any explicit `behaviors:` entries, explicit-first so order is
  // stable for pre-existing fixtures. Mirrors the dedup in
  // src/patterns/validate-composition.ts.
  const behaviorNames = resolvedBehaviorNames(definition);
  const hasTimestamps = behaviorNames.includes('timestamps');
  const hasSoftDelete = behaviorNames.includes('soft_delete');
  const hasUserTracking = behaviorNames.includes('user_tracking');
  const hasExternalIdTracking = behaviorNames.includes('external_id_tracking');

  // #845 (#796 follow-up): whether each timestamp behavior's columns are
  // timestamptz — the behavior's own `options: { timezone }`, else the project's
  // `behaviors.timezone`. The rule is `behaviorWithTimezone`
  // (src/schema/field-timestamp.ts); entity.ejs.t passes these to
  // `timestampColumn`, the one place the column literal is written.
  // Required: prompt.js reads it from the parsed config, whose schema owns the
  // default. An absent value must not silently become `true` and drop a
  // project's `behaviors.timezone: false`.
  const projectBehaviorsTimezone = baseLocals.behaviorsTimezone;
  if (typeof projectBehaviorsTimezone !== 'boolean') {
    throw new Error(
      `buildBackendLocals(${entity.name}): baseLocals.behaviorsTimezone must be the project's ` +
        `behaviors.timezone (a boolean); got ${String(projectBehaviorsTimezone)}.`,
    );
  }
  const timestampsWithTimezone = behaviorWithTimezone(behaviors, 'timestamps', projectBehaviorsTimezone);
  const softDeleteWithTimezone = behaviorWithTimezone(behaviors, 'soft_delete', projectBehaviorsTimezone);

  // ==========================================================================
  // Tenant scoping (ADR-042 / TEN-1). One YAML flag drives the column, the
  // index, the uniqueness prefix, the BehaviorConfig field and the repository's
  // strict enforcement — one declaration, five emissions (charter I1).
  //
  // #791: the column is configurable (`tenancy.column` in codegen.config.yaml,
  // or `tenant_scoped: { column }`), and a column the entity already declares —
  // a field or a belongs_to FK — is ADOPTED rather than emitted twice. The rule
  // is `resolveTenancy` (src/schema/tenancy.ts), shared with the relations
  // emitter. `baseLocals.tenancyColumn` is the project default prompt.js reads
  // from the config; absent means the schema default.
  // ==========================================================================
  const tenancy = resolveTenancy(
    entityName,
    definition,
    projectTenancyColumn,
  );
  const tenantScoped = tenancy !== null;
  // The tenant block in entity.ejs.t emits the column only when nothing adopts it.
  const tenantColumnEmitted = tenantScoped && tenancy.adopted === null;
  // The BehaviorConfig key — ALWAYS emitted for a scoped entity (the runtime's
  // `BehaviorConfig` requires it when `tenantScoped`); `null` only when unscoped.
  const behaviorTenantColumn = tenantScoped ? tenancy.prop : null;

  // A tenant-scoped entity whose repository would upsert on a caller-supplied
  // conflict target is a cross-tenant WRITE waiting to happen: the ON CONFLICT
  // target selects the row before any WHERE applies. The EAV value-table
  // repository emits exactly that (`upsertCurrentValues`), and its conflict
  // target is author-declared, so it cannot be prefixed with the tenant column
  // without breaking index inference. Refuse the combination rather than emit a
  // repository that claims an isolation it does not have (TEN-1 §5.2).
  if (tenantScoped && eavValueTable) {
    throw new Error(
      `Entity '${entityName}': tenant_scoped: true is not supported with ` +
        'eav_value_table: true. The generated upsertCurrentValues() upserts on ' +
        'an author-declared conflict target, which cannot carry the tenant column, so ' +
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
  const hasMultiFieldQuery = processedQueries.some((q) => q.hasMultipleParams);
  const hasOrderedQuery = processedQueries.some((q) => q.hasOrder);
  const hasViaQuery = processedQueries.some((q) => q.hasVia);

  // Process belongs_to relationships. Pass the raw fields map so a FK column
  // also declared as a field inherits its `required`/`nullable` (→ .notNull())
  // and `index: true` (→ a single-column index emitted below).
  const belongsTo = processBelongsTo(relationships, targetNaming, fields);
  // TGT-1: each single-column belongs_to FK's `.references(…)` suffix is the target's text, keyed by the FK column. A
  // `match:` relationship has none: it is half of a composite FK (the constraints block). The template reads it
  // through `belongsToReference`, which throws on a missing one — never a silently FK-less column.
  const belongsToReferenceByField = Object.fromEntries(
    belongsTo
      .filter((rel) => !rel.match)
      .map((rel) => [
        rel.field,
        constraints.columnReference({ targetExport: rel.relatedTable, targetProp: 'id', onDelete: rel.onDelete }),
      ]),
  );

  // Process has_many relationships (CGP-358b)
  // `renderSet` (#815) is an input; no template reads it. It is the entities the same
  // run renders, so a has_many onto a later one is wired in one pass.
  const hasMany = processHasMany(
    relationships,
    targetNaming,
    new Set(baseLocals.renderSet ?? []),
  );

  // The other entities whose repository this service composes (#632): one
  // entry per target, whichever edges reach it — a belongs_to and a has_many
  // onto the same target share one import and one constructor parameter.
  const repositoryDeps = collectRepositoryDeps(
    belongsTo,
    hasMany.filter((r) => r.targetExists),
  );

  // The other entities' MODULES this module imports (ADR-002): a service that composes another entity's repository
  // gets it from that entity's home module, which exports it — the only place the repository's own dependencies are
  // wired (a joined-table child's repository injects its base's, an EAV repository its field-value service). A
  // module that provided the repository itself would have to repeat that closure. Every such import prints
  // `forwardRef(() => …)`: an ES-module cycle can close through a junction's module or the EAV block's import, which no
  // graph computed here would see, and `forwardRef` on an import that is not in a cycle changes nothing at runtime.
  // JUNC-0 (#678): every junction naming this entity in `between:` is mirrored
  // onto its service + module here, from the junction YAML set — the parent's
  // own templates render the fan-out; nothing injects into them. A counterparty
  // type the service already imports for a composed repository is not imported
  // twice (nor for a second junction onto the same counterparty).
  const junctionFanOut = junctionFanOutFor(entityName, {
    junctions: baseLocals.junctions ?? [],
    modulesDir,
    entityLookup,
    selfModuleDir: moduleDir,
  });
  const importedEntityTypes = new Set(
    repositoryDeps.map((dep) => `${dep.importDir}/${dep.fileStem}.entity`),
  );
  for (const block of junctionFanOut) {
    block.importCounterparty = !importedEntityTypes.has(block.counterpartyEntityImport);
    importedEntityTypes.add(block.counterpartyEntityImport);
  }
  const eavDefinitionDep = eavDefinitionEntity
    ? repositoryDeps.find((d) => d.entity === eavDefinitionEntity) ?? null
    : null;

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
      repositoryDir: moduleDir,
      modulesDir,
      entityLookup,
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


  // Filter FK fields that are already emitted by the belongsTo loop
  const fkFieldNames = new Set(belongsTo.map((r) => r.field));
  const nonFkFields = processedFields.filter((f) => !fkFieldNames.has(f.name));

  // Field-level foreign_key + index emission (#354, #355). Mutates the
  // drizzleChain of the rendered (non-belongs_to) columns in place. Skip FK
  // imports for tables belongs_to already imports to avoid duplicate import
  // lines.
  // #511: on a non-tenant entity a field with both `unique: true` and
  // `index: true` gets only the unique index (it leads with the column). Under
  // tenant_scoped the unique index is (<tenant column>, col) and cannot serve a
  // lookup on col alone, so the author's `index: true` is kept.
  const suppressedIndexNames = new Set();
  if (!tenantScoped) {
    for (const [name, def] of Object.entries(fields || {})) {
      if (name !== 'id' && def && def.unique === true && def.index === true) {
        suppressedIndexNames.add(name);
      }
    }
  }
  // `suppressedIndexNames` therefore also holds the adopted tenant column: its
  // own `index: true` is the tenant index below, under the same
  // `<table>_<column>_idx` name, and emitting both is a C3 duplicate.
  if (tenantScoped && tenancy.adopted) suppressedIndexNames.add(tenancy.column);
  const fieldFeatures = processFieldFeatures(
    nonFkFields,
    fields,
    targetNaming,
    baseLocals?.ownedTableNames,
    suppressedIndexNames,
    constraints,
  );
  const belongsToTables = new Set(belongsTo.map((r) => r.relatedTable));
  const fieldFkImports = fieldFeatures.fkImports.filter(
    (imp) => !belongsToTables.has(imp.relatedTable),
  );
  // The entity file's parent-table imports for its belongs_to columns: one per
  // TABLE, not one per edge — two belongs_to onto one target reference the
  // same table export, and importing it twice is TS2300 (#731). The entity's
  // own table is declared in the file, never imported.
  const belongsToTableImports = [];
  for (const rel of belongsTo) {
    if (rel.relatedTable === entityNamePlural) continue;
    if (belongsToTableImports.some((imp) => imp.relatedTable === rel.relatedTable)) continue;
    belongsToTableImports.push({ relatedTable: rel.relatedTable, importPath: rel.importPath });
  }

  // ==========================================================================
  // Joined-table inheritance and `match:` (RFC-0006 §2, #875). Cross-entity:
  // a child's table reads its base's discriminator + tenant column, and a base /
  // `match:` target carries the unique(id, …) its referrers' composite FKs
  // point at — each rendered by this entity's OWN template from the other
  // side's YAML (`_shared/inheritance.mjs`).
  // ==========================================================================
  const inheritance = inheritanceFor({
    entityName,
    definition,
    // Locals built by hand (a unit test) carry no lookup: they have no cross-entity YAML to read.
    lookup: entityLookup ?? entityLookupFrom([]),
    ownNaming,
    modulesDir,
    tenancyColumn: projectTenancyColumn,
  });
  const inheritedChild = inheritance.child;
  const isChild = inheritedChild !== null;

  // RFC-0006 §3, §6 (S3): the READ half of a family. A child's reads are scoped
  // by its base's tenant column and (through `baseScope`) the base's
  // `soft_delete` / `user_tracking`, which the child does not declare (R5); a
  // base reads across its kinds.
  const familyBaseBehaviors = isChild ? resolvedBehaviorNames(entityLookup.definition(inheritedChild.base)) : [];
  const family = familyReads({
    entityName,
    definition,
    lookup: entityLookup,
    ownNaming,
    modulesDir,
    baseBehaviors: familyBaseBehaviors,
  });
  // A joined-table child's repository injects its base's, which the base's module exports: the base is the FIRST
  // entry, and one entry per entity — a child that also relates to its own base imports that module once.
  const repositoryDepModules = [
    ...(family.child ? [{ entity: family.child.baseName, importDir: family.child.baseModuleDir, inherits: true }] : []),
    ...repositoryDeps
      // The EAV definition's module is imported by the EAV block of the module template.
      .filter((dep) => !(eavValueTable && dep.entity === eavDefinitionEntity)),
  ]
    .filter((dep, i, all) => all.findIndex((other) => other.entity === dep.entity) === i)
    .map((dep) => {
      const depNaming = entityModuleNaming(entityLookup(dep.entity), modulesDir);
      return {
        entity: dep.entity,
        moduleClass: moduleClassName(depNaming.plural),
        importPath: `${dep.importDir}/${emittedStem(depNaming.plural)}.module`,
        inherits: dep.inherits === true,
      };
    });

  // The entities that `inherits:` this one — the derivation's input (`inheritanceChildren`): a base's cross-kind
  // reads and a family member's typed include both follow from it (`apiSurface.repository.methods` / `.typedInclude`).
  // From `familyReads` — the one enumeration of the set (it throws where a base cannot enumerate); a base with no
  // `discriminator:` has no children (R1).
  const familyChildren = (family.base?.children ?? []).map((c) => ({ name: c.name, as: c.as }));
  // The write half's input (S4): a child's base — the natural-key upsert it writes through. The derivation
  // (`apiSurface.repository.methods` / `.service.methods`) decides which writes exist; nothing here does.
  const inheritanceBase = inheritanceBaseOf(definition, entityLookup?.definitions ? entityLookup.definitions() : []);
  // The scope a child's repository declares: its tenant column (the base's, carried as a copy) with strict
  // enforcement, plus the base's lifecycle scope. A plain entity's is its own `tenantScoped`.
  const scopeTenantColumn = tenantScoped ? tenancy.prop : isChild && inheritedChild.tenant ? inheritedChild.tenant.prop : null;
  const scopeTenantScoped = scopeTenantColumn !== null;

  // The columns a child carries from its base, right after `id`: the kind (the
  // base's own pgEnum, fixed by DEFAULT + CHECK) and the tenant column (NOT
  // NULL). Both are copies the base row owns, pinned by the two composite FKs.
  const inheritedKeyColumns = [];
  if (isChild) {
    inheritedKeyColumns.push({
      column: inheritedChild.kind.column,
      prop: inheritedChild.kind.prop,
      line:
        `${inheritedChild.kind.prop}: ${inheritedChild.kind.enumName}('${inheritedChild.kind.column}')` +
        `.$type<'${inheritedChild.as}'>().notNull().default('${inheritedChild.as}')`,
      drizzleType: 'enum',
      enumImport: { enumName: inheritedChild.kind.enumName, importPath: inheritedChild.kind.importPath },
    });
    if (inheritedChild.tenant) {
      inheritedKeyColumns.push({
        column: inheritedChild.tenant.column,
        prop: inheritedChild.tenant.prop,
        line: `${inheritedChild.tenant.prop}: uuid('${inheritedChild.tenant.column}').notNull()`,
        drizzleType: 'uuid',
        enumImport: null,
      });
    }
  }

  // `match:` — one derived local column per distinct local name, unless the
  // table already has that column (its own discriminator: M2's exception; a
  // child's carried kind / tenant column).
  const existingMatchColumns = new Set(inheritedKeyColumns.map((c) => c.column));
  if (typeof definition.discriminator === 'string') existingMatchColumns.add(definition.discriminator);
  for (const f of Object.keys(fields)) existingMatchColumns.add(f);
  const matched = matchColumns({
    entityName,
    relationships,
    lookup: entityLookup,
    existing: existingMatchColumns,
    nullableByRel: new Map(belongsTo.map((r) => [r.relName, r.nullable])),
    modulesDir,
    fromNaming: ownNaming,
  });
  const matchDerivedColumns = matched.derived.map((d) => {
    let chain;
    let drizzleType;
    let enumImport = null;
    if (d.kind === 'fk') {
      drizzleType = 'uuid';
      chain = `uuid('${d.column}')${d.nullable ? '' : '.notNull()'}`;
    } else if (d.enumRef) {
      drizzleType = 'enum';
      enumImport = { enumName: d.enumRef.enumName, importPath: d.enumRef.importPath };
      chain = `${d.enumRef.enumName}('${d.column}')${d.nullable ? '' : '.notNull()'}`;
    } else {
      // The target column's own type, none of its constraints (default / unique / index / FK).
      const { type, max_length, min_length, timezone } = d.field;
      const [pf] = processFields(
        { [d.column]: { type, max_length, min_length, timezone, ...(d.nullable ? {} : { required: true }) } },
        { entityName: d.targetEntity, enumResolver: null, columns },
      );
      drizzleType = pf.drizzleType;
      chain = pf.drizzleChain;
    }
    return { column: d.column, prop: camelCase(d.column), line: `${camelCase(d.column)}: ${chain}`, drizzleType, enumImport };
  });

  // Field-level `unique: true` (#511) and composite unique indexes (#356),
  // through one builder.
  const tableColumns = entityTableColumns({
    belongsTo,
    nonFkFields,
    hasExternalIdTracking,
    tenancy,
    hasTimestamps,
    hasSoftDelete,
    extraColumns: [...inheritedKeyColumns, ...matchDerivedColumns].map((c) => ({ column: c.column, prop: c.prop })),
  });
  const uniqueIndexExpressions = processUniqueIndexes(
    [
      ...fieldUniqueEntries(fields, tenancy),
      ...(definition.unique_indexes ?? []).map((ui, i) => ({ ...ui, source: `unique_indexes[${i}]` })),
    ],
    { entityName, tableName: entityTableName, tenancy, tableColumns, constraints },
  );

  // RFC-0006 §2.4 (S4): the columns this table DERIVES from a parent row, and the parents each is read from — in
  // relationship declaration order, the first that resolves wins. The generated repository fills them in the same
  // statement as the write (`fillDerivedColumns`). M2's discriminator exception derives nothing, so it has no entry.
  const matchFills = matchDerivedColumns.map((dc) => ({
    key: dc.prop,
    column: dc.column,
    sources: matched.fks.flatMap((fk) => {
      const pair = fk.pairs.find(([local]) => local === dc.column);
      const rel = pair && belongsTo.find((r) => r.relName === fk.relName);
      return rel
        ? [{ fkKey: rel.camelField, parentTable: rel.relatedTable, parentImportPath: rel.importPath, parentProp: camelCase(pair[1]) }]
        : [];
    }),
  }));

  // `natural_key: true` (R11): the conflict target of `upsertByNaturalKey` — the declared columns, tenant-prefixed
  // exactly as the unique index is. A child declares none (R11); its upsert uses its base's.
  const naturalKeyIndex = naturalKeyIndexOf(definition);
  const naturalKeyEntry =
    naturalKeyIndex < 0 ? null : uniqueIndexExpressions.find((u) => u.source === `unique_indexes[${naturalKeyIndex}]`);
  const naturalKey = naturalKeyEntry
    ? { props: naturalKeyEntry.columns.map((c) => tableColumns.find((tc) => tc.column === c).prop) }
    : null;

  // belongs_to FK columns that declared `index: true` on their underlying
  // field. The FK column lives in belongsTo (not processedFields), so
  // processFieldFeatures never sees it — emit its index here using the same
  // `<table>_<col>_idx` naming a non-FK indexed field gets.
  const belongsToIndexExpressions = belongsTo
    .filter((rel) => rel.hasIndex && !suppressedIndexNames.has(rel.field))
    .map((rel) => ({
      comment: null,
      expr: constraints.index({ name: `${entityTableName}_${rel.field}_idx`, props: [rel.camelField] }, T),
      name: `${entityTableName}_${rel.field}_idx`,
      builder: 'index',
      source: `belongs_to '${rel.field}' index`,
    }));

  // pgTable extra-config callback entries, in emission order: the tenant index
  // (tenant_scoped, unshifted below), belongs_to FK indexes, single-column field
  // indexes, field `unique: true` uniques (in `fields:` order, #511), then
  // `unique_indexes:` entries (each a uniqueIndex or, under NULLS NOT DISTINCT,
  // a `unique(...)` constraint, #784), then the external_id_tracking unique
  // (the ON CONFLICT target integrationUpsert relies on).
  const tableConstraints = [
    ...belongsToIndexExpressions,
    ...fieldFeatures.indexExpressions,
    ...uniqueIndexExpressions,
  ];
  if (tenantScoped) {
    // Every scoped read filters on this column, so it is indexed unconditionally.
    tableConstraints.unshift({
      comment: `tenant_scoped behavior (ADR-042) — every scoped read filters on ${tenancy.column}`,
      expr: constraints.index({ name: `${entityTableName}_${tenancy.column}_idx`, props: [tenancy.prop] }, T),
      name: `${entityTableName}_${tenancy.column}_idx`,
      builder: 'index',
      source: 'tenant_scoped',
    });
  }
  if (hasExternalIdTracking) {
    tableConstraints.push(
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
              `unique('uq_${entityTableName}_tenant_provider_external_id')` +
              `.on(${T}.${tenancy.prop}, ${T}.provider, ${T}.externalId).nullsNotDistinct()`,
            name: `uq_${entityTableName}_tenant_provider_external_id`,
            builder: 'unique',
            partial: false,
            columns: [tenancy.column, 'provider', 'external_id'],
            source: 'external_id_tracking',
          }
        : {
            comment: 'external_id_tracking behavior — ON CONFLICT target for integrationUpsert',
            expr: `uniqueIndex('uq_${entityTableName}_provider_external_id').on(${T}.provider, ${T}.externalId)`,
            name: `uq_${entityTableName}_provider_external_id`,
            builder: 'uniqueIndex',
            partial: false,
            columns: ['provider', 'external_id'],
            source: 'external_id_tracking',
          },
    );
  }

  // RFC-0006 constraints (§2.1, §2.2, §2.4), appended after every other entry. Facts here; text from the target's
  // constraint renderer (TGT-1).
  const propOf = (column) => camelCase(column);
  const fkExpr = (name, columns, targetExport, targetColumns, onDelete) =>
    constraints.foreignKey(
      { name, props: columns.map(propOf), targetExport, targetProps: targetColumns.map(propOf), onDelete },
      T,
    );
  // The targets of other tables' composite FKs: unique(id, <cols>), one per column set.
  const uniqueTargetEntry = (name, columns) => {
    const { expr, builder } = constraints.unique(
      {
        name,
        props: ['id', ...columns].map(propOf),
        where: null,
        nullsNotDistinct: false,
        referenced: true,
        tenantScoped: false,
      },
      T,
    );
    return { expr, builder };
  };
  for (const u of inheritance.uniqueTargets) {
    const name = `${entityTableName}_id_${u.columns.join('_')}_uniq`;
    tableConstraints.push({
      comment: `inherits / match: the target of a composite FK (id, ${u.columns.join(', ')})`,
      ...uniqueTargetEntry(name, u.columns),
      name,
      partial: false,
      columns: ['id', ...u.columns],
      source: `inherits / match: unique(id, ${u.columns.join(', ')})`,
    });
  }
  // `match:` — one composite FK per relationship, in place of the column's single-column FK.
  for (const fk of matched.fks) {
    const rel = belongsTo.find((r) => r.relName === fk.relName);
    const name = `${entityTableName}_${fk.relName}_match_fk`;
    tableConstraints.push({
      comment: `match: (${[rel.field, ...fk.pairs.map(([l]) => l)].join(', ')}) → ${rel.relatedEntity}(id, ${fk.pairs.map(([, t]) => t).join(', ')})`,
      expr: fkExpr(name, [rel.field, ...fk.pairs.map(([l]) => l)], rel.relatedTable, ['id', ...fk.pairs.map(([, t]) => t)], rel.onDelete),
      name,
      builder: 'foreignKey',
      source: `match: on relationship '${fk.relName}'`,
    });
  }
  // A derived column that is nullable (EVERY relationship matching it is nullable) would let a set FK skip its
  // composite check: MATCH SIMPLE does not check a row with a NULL in any key column. So the FK and the derived
  // column are checked together, per relationship: a SET FK needs its derived column (RFC-0006 §2.4). The
  // reverse (a derived column with no FK) is harmless, and another nullable FK may be the one using it.
  const nullableDerived = new Set(matched.derived.filter((d) => d.nullable).map((d) => d.column));
  for (const fk of matched.fks) {
    const rel = belongsTo.find((r) => r.relName === fk.relName);
    const locals = fk.pairs.map(([l]) => l).filter((l) => nullableDerived.has(l));
    if (locals.length === 0) continue;
    const name = `${entityTableName}_${fk.relName}_match_check`;
    // `<fk> IS NULL OR <derived> IS NOT NULL`, per derived column, parenthesised and ANDed when there are several.
    const expression = locals.flatMap((l, i) => {
      const clause = [
        { column: rel.field, prop: camelCase(rel.field) },
        { text: ' IS NULL OR ' },
        { column: l, prop: camelCase(l) },
        { text: ' IS NOT NULL' },
      ];
      const one = locals.length > 1 ? [{ text: '(' }, ...clause, { text: ')' }] : clause;
      return i === 0 ? one : [{ text: ' AND ' }, ...one];
    });
    tableConstraints.push({
      comment: `match: a set ${rel.field} needs ${locals.join(', ')}, so it always reaches its composite FK (MATCH SIMPLE skips a NULL)`,
      expr: constraints.check({ name, expression }, T),
      name,
      builder: 'check',
      source: `match: on relationship '${fk.relName}' (nullable)`,
    });
  }
  // A child: tenant index, the two composite FKs to the base row, the kind CHECK.
  if (isChild) {
    const baseName = inheritedChild.base;
    const disc = inheritedChild.discriminator;
    if (inheritedChild.tenant) {
      const t = inheritedChild.tenant;
      tableConstraints.unshift({
        comment: `inherits: the tenant column comes from the base (${baseName}), indexed like any tenant-scoped table`,
        expr: constraints.index({ name: `${entityTableName}_${t.column}_idx`, props: [t.prop] }, T),
        name: `${entityTableName}_${t.column}_idx`,
        builder: 'index',
        source: 'inherits: tenant column',
      });
    }
    const kindFk = `${entityTableName}_${baseName}_${disc}_fk`;
    tableConstraints.push({
      comment: `inherits ${baseName}: this row sits only under a ${baseName} row whose ${disc} is ${inheritedChild.as}`,
      expr: fkExpr(kindFk, ['id', disc], inheritedChild.baseTable, ['id', disc], 'cascade'),
      name: kindFk,
      builder: 'foreignKey',
      source: 'inherits: kind FK',
    });
    if (inheritedChild.tenant) {
      const t = inheritedChild.tenant;
      const tenantFk = `${entityTableName}_${baseName}_tenant_fk`;
      tableConstraints.push({
        comment: `inherits ${baseName}: the tenant of this row is the tenant of its ${baseName} row`,
        expr: fkExpr(tenantFk, ['id', t.column], inheritedChild.baseTable, ['id', t.column], 'cascade'),
        name: tenantFk,
        builder: 'foreignKey',
          source: 'inherits: tenant FK',
      });
    }
    const checkName = `${entityTableName}_${disc}_check`;
    tableConstraints.push({
      comment: `inherits ${baseName}: the kind is fixed (DEFAULT + CHECK, not a generated column)`,
      expr: constraints.check(
        {
          name: checkName,
          expression: [{ column: disc, prop: inheritedChild.kind.prop }, { text: ` = '${inheritedChild.as}'` }],
        },
        T,
      ),
      name: checkName,
      builder: 'check',
      source: 'inherits: kind CHECK',
    });
  }

  for (const c of tableConstraints) {
    if (!c.name || !c.builder) {
      throw new Error(
        `[codegen] '${entityName}': internal error — extra-config entry '${c.expr}' lacks a name or builder.`,
      );
    }
  }
  assertDistinctConstraints(tableConstraints, entityName);

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
  const enumFields = processedFields
    .filter((f) => f.hasChoices && f.enumName && !f.enumImport)
    .map((f) => ({
      enumName: f.enumName,
      dbName: f.enumDbName,
      choices: f.choices,
    }));

  // Imports of other entities' exports the inheritance DDL needs: a child's base
  // table + the base's kind pgEnum, an IMPORTED enum (`choices_of:`, a `match:`
  // local typed by the target's enum). One statement per module, and never a
  // name the belongs_to / field-FK imports already bring (TS2300).
  const alreadyImported = new Set([
    entityNamePlural,
    ...belongsToTableImports.map((i) => i.relatedTable),
    ...fieldFkImports.map((i) => i.relatedTable),
  ]);
  const inheritanceImportMap = new Map();
  // An enum this entity declares is imported from its own `.enums` leaf by the entity template already
  // (a self-targeting `match:` onto the entity's own enum column derives a column typed with it).
  const ownEnumNames = new Set(enumFields.map((e) => e.enumName));
  const wantImport = (importPath, name) => {
    if (alreadyImported.has(name) || ownEnumNames.has(name)) return;
    // One statement per module: fold into a belongs_to table import from the same file.
    const sameModule = belongsToTableImports.find((imp) => imp.importPath === importPath);
    if (sameModule) {
      sameModule.extraNames = [...new Set([...(sameModule.extraNames ?? []), name])].sort();
      return;
    }
    if (!inheritanceImportMap.has(importPath)) inheritanceImportMap.set(importPath, new Set());
    inheritanceImportMap.get(importPath).add(name);
  };
  if (isChild) wantImport(inheritedChild.baseImportPath, inheritedChild.baseTable);
  for (const c of [...inheritedKeyColumns, ...matchDerivedColumns]) {
    if (c.enumImport) wantImport(c.enumImport.importPath, c.enumImport.enumName);
  }
  for (const f of processedFields) {
    if (f.enumImport) wantImport(f.enumImport.importPath, f.enumImport.enumName);
  }
  const inheritanceImports = [...inheritanceImportMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([importPath, names]) => ({ importPath, names: [...names].sort() }));

  // Drizzle imports needed, derived by use (#784): the pg-core builders the
  // extra-config callback actually calls, plus `sql` (drizzle-orm) when a
  // partial entry renders a predicate.
  const extraDrizzleImports = [...new Set(tableConstraints.map((c) => c.builder))];
  const drizzleOrmImports = [
    ...(uniqueIndexExpressions.some((u) => u.partial) || tableConstraints.some((c) => c.builder === 'check') ? ['sql'] : []),
  ];
  // The columns this file renders beyond `processedFields`: the child's kind and tenant, `match:` locals.
  const inheritanceColumnFields = [...inheritedKeyColumns, ...matchDerivedColumns].map((c) => ({
    drizzleType: c.drizzleType,
    enumImport: c.enumImport,
  }));
  const drizzleEntityImports = collectDrizzleImports(columns, [...processedFields, ...inheritanceColumnFields], belongsTo, hasTimestamps, hasSoftDelete, hasExternalIdTracking, extraDrizzleImports);

  // ADR-046 — the generated API surface, derived once (`src/derived/api/`). Every
  // method name the repository prints, and whether it is emitted at all, comes
  // from here; the templates loop over it and choose a body by `kind`. Built
  // from what this function already holds: the definition, the junction set,
  // the resolved composition, the has_many targets that will exist, and the
  // cross-entity lookup.
  const apiSurface = deriveEntityApiSurface({
    definition,
    junctions: baseLocals.junctions ?? [],
    composition: patternBase,
    wiredTargets: hasMany.filter((r) => r.targetExists).map((r) => r.target),
    inheritanceChildren: familyChildren,
    inheritanceBase,
    discriminatorKinds: discriminatorKindsOf(definition, entityLookup?.definitions ? entityLookup.definitions() : []),
    entityLookup: (name) => (entityLookup ? entityLookup(name) : null),
  });
  // Whether writes are emitted is the derivation's answer (ADR-046): `generate.writes: false`; a base with a child for every kind has no create (RFC-0006 §4.1, S5).
  const hasUseCase = (kind) => apiSurface.useCases.some((u) => u.kind === kind);

  // Output paths
  const outputPaths = {
    entity: `${ownNaming.entityFile}.ts`,
    repository: ownNaming.repositoryFile,
    service: `${moduleDir}/${emittedStem(entityName)}.service.ts`,
    controller: `${moduleDir}/${emittedStem(entityName)}.controller.ts`,
    module: ownNaming.moduleFile,
    index: `${moduleDir}/index.ts`,
    // The `pgEnum` declarations — a leaf module with no entity imports; null when the entity declares none.
    enums: enumFields.length > 0 ? `${ownNaming.enumsFile}.ts` : null,
    findByIdUseCase: `${useCasesDir}/${emittedStem('find', entityName, 'by-id')}.use-case.ts`,
    listUseCase: `${useCasesDir}/${emittedStem('list', entityNamePlural)}.use-case.ts`,
    findByIdWithFieldsUseCase: eavEnabled
      ? `${useCasesDir}/${emittedStem('find', entityName, 'by-id-with-fields')}.use-case.ts`
      : null,
    listWithFieldsUseCase: eavEnabled
      ? `${useCasesDir}/${emittedStem('list', entityNamePlural, 'with-fields')}.use-case.ts`
      : null,
    createUseCase: hasUseCase('create')
      ? `${useCasesDir}/${emittedStem('create', entityName)}.use-case.ts`
      : null,
    updateUseCase: hasUseCase('update')
      ? `${useCasesDir}/${emittedStem('update', entityName)}.use-case.ts`
      : null,
    deleteUseCase: hasUseCase('delete')
      ? `${useCasesDir}/${emittedStem('delete', entityName)}.use-case.ts`
      : null,
    createDto: `${moduleDir}/dto/${dtoFileStem(entityName, 'create')}.dto.ts`,
    updateDto: `${moduleDir}/dto/${dtoFileStem(entityName, 'update')}.dto.ts`,
    outputDto: `${moduleDir}/dto/${dtoFileStem(entityName, 'output')}.dto.ts`,
    // RFC-0006 §5: a base with child tables also emits the cross-kind output (`<Base>OfKindSchema`).
    ofKindDto: family.base !== null && family.base.children.length > 0
      ? `${moduleDir}/dto/${dtoFileStem(entityName, 'ofKind')}.dto.ts`
      : null,
    // Pagination-by-default: the universal list query DTO (page/cursor/pageSize
    // + sort). Always emitted — the list endpoint is unconditional.
    listQueryDto: `${moduleDir}/dto/${emittedStem('list', entityNamePlural)}.query.ts`,
    searchUseCase: searchQueryResolved
      ? `${useCasesDir}/${emittedStem('search', entityNamePlural)}.use-case.ts`
      : null,
    searchController: searchQueryResolved
      ? `${moduleDir}/${emittedStem(entityName, 'search')}.controller.ts`
      : null,
    declarativeQueries: hasDeclarativeQueries
      ? `${useCasesDir}/declarative-queries.ts`
      : null,
    // ADR-041 — the generated `<Entity>ComposedBase` that applies the mixin
    // chain. Emitted only when TWO OR MORE capabilities stack; one capability
    // is wrapped inline in the repository's `extends` clause, and none leaves
    // the repository byte-identical to its pre-CAP-1 shape.
    composedBase: capabilityMixins.length >= 2
      ? `${moduleDir}/${emittedStem(entityName)}.composed-base.ts`
      : null,
    // ADR-033.1 §8 — integration-source module emission for backend. Co-located
    // with the entity feature module under <modules_dir>/<plural>/. Closes #267.
    // #403: routed through moduleDir so a `context:`-tagged entity nests the
    // integration-source module under its context segment (untagged → flat,
    // `<modules_dir>/<plural>/…`).
    integrationSourceModule: `${moduleDir}/${emittedStem(entityName, 'integration-source')}.module.ts`,
    // ADR-033.2's per-entity provider tuples (`<entity>-integration-source.providers.ts`)
    // are removed by RFC-0001 §8 (D4). The surface-scoped typed view
    // (`src/integrations/<surface>/types.generated.ts`) is the single source of
    // provider truth now — see src/cli/shared/adapter-emission-generator.ts.
  };

  // Architecture-specific imports for backend. The integration-source module
  // imports the entity type sibling-style (`./<entity>.entity`) since the
  // module file lives next to the entity file in the same feature folder.
  const imports = {
    integrationSourceToEntity: `./${entityFileStem}.entity`,
  };

  // Class names
  const classNames = {
    entity: entityNamePascal,
    entityTable: entityNamePlural,
    repository: `${entityNamePascal}Repository`,
    service: `${entityNamePascal}Service`,
    controller: `${entityNamePascal}Controller`,
    module: moduleClassName(entityNamePlural),
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
    // RFC-0006 §5: a child's own columns alone, and a base's output across its kinds — one owner of every schema
    // name, which a child's import of its base's schema reads too.
    ...dtoSchemaNames(entityName),
    ofKindDto: `${entityNamePascal}OfKindDto`,
    // Pagination-by-default: list query DTO + schema (re-export of the shared
    // ListQuerySchema). Named per-entity so the controller import is unambiguous.
    listQueryDto: `List${entityNamePluralPascal}QueryDto`,
    listQuerySchema: `List${entityNamePluralPascal}QuerySchema`,
  };

  // Fields for create DTO: exclude id, behavior-managed fields, and FK fields
  // An adopted tenant column (#791) is stamped by the repository from the
  // ambient tenant, exactly as an emitted one is — it is never a DTO input.
  const isTenantColumn = (name) => tenantScoped && name === tenancy.column;
  const createDtoFields = nonFkFields.filter(
    (f) => !BEHAVIOR_MANAGED_FIELDS.has(f.name)
        && !(hasExternalIdTracking && EXTERNAL_ID_TRACKING_FIELDS.has(f.name))
        && !isTenantColumn(f.name),
  );

  // FK fields from belongs_to for the entity's output DTO (every belongs_to)
  const belongsToFkFields = belongsTo.map((rel) => ({
    camelName: rel.camelField,
    zodChainCreate: rel.nullable ? 'z.guid().nullable().optional()' : 'z.guid()',
    zodChainUpdate: rel.nullable ? 'z.guid().nullable().optional()' : 'z.guid().optional()',
    zodChainOutput: rel.nullable ? 'z.guid().nullable()' : 'z.guid()',
    nullable: rel.nullable,
  }));

  // ...and for the create DTO: an adopted tenant FK (#791) is stamped, not input.
  const createFkFields = belongsToFkFields.filter((fk) => !(tenantScoped && fk.camelName === tenancy.prop));

  // The kinds with no child table — the only ones a base's own create accepts (RFC-0006 §4.1, §5).
  const baseOnlyKinds = family.base === null ? [] : family.base.baseOnlyKinds;

  // Build zodChain for each create DTO field
  // RFC-0006 §5: a base's discriminator accepts only its base-only kinds (`z.never()` when every kind has a child:
  // the field stays so a child's `.omit({ kind: true })` has something to omit, and the base has no create route).
  const createDtoFieldsWithZod = createDtoFields.map((f) => ({
    ...f,
    zodChainCreate:
      family.base !== null && f.name === family.base.discriminator
        ? baseOnlyKinds.length === 0
          ? 'z.never()'
          : `z.enum([${baseOnlyKinds.map((k) => `'${k}'`).join(', ')}])`
        : zodChainForCreate(f),
    zodChainUpdate: zodChainForUpdate(f),
    createAppliesDefault: createChainAppliesDefault(f),
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
    sinkPolicy,
    tenancy,
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
  // REL-2 (#587): `Relations` is the THIRD type argument of every spine base.
  // Threading it here rather than in the template is what makes a composed base
  // (ADR-041 §6) carry the relation manifest exactly as a bare spine does.
  const spineTypeArgs = integrationSurface !== null
    ? [
        classNames.entity,
        `typeof ${entityNamePlural}`,
        'Relations',
        `${classNames.entity}IntegrationWrite`,
        `${classNames.entity}IntegrationProjection`,
      ]
    : [classNames.entity, `typeof ${entityNamePlural}`, 'Relations'];
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
  // vocabularies it generates or that a pattern declares — including the
  // spine's declared `repositoryInheritedMethods` / `serviceInheritedMethods`
  // (#688); a clash against an undeclared method of an opaque spine base still
  // surfaces as a consumer compile error, which ADR-041 §4 accepts as
  // irreducible.
  //
  // Only collisions INVOLVING a capability are errors here — the `queries:` ×
  // FK-traversal overlap is pre-existing and resolved by the precedence rule
  // derived in src/derived/api/entity.ts (ADR-046), not an undetected clash.
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
      methods: processedQueries.map((q) => finderName(q)),
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
    {
      // repository.ejs.t's FK-traversal methods, one per belongs_to.
      source: 'an FK-traversal method',
      methods: belongsTo.map((rel) => fkFinderName(rel.field)),
      capability: false,
    },
    // The two spine sides stay SEPARATE vocabularies so the error names the one
    // that actually clashes (#688 review nit 1). A capability's
    // `forwarderMethods` reach both: the service emits the forwarder, and the
    // mixin has to carry the method it forwards to, so either side is a real
    // collision.
    {
      source: `the spine '${patternBase.patternName}' (repository)`,
      methods: splitMethodList(patternBase.repositoryInheritedMethods),
      capability: false,
    },
    {
      source: `the spine '${patternBase.patternName}' (service)`,
      methods: splitMethodList(patternBase.serviceInheritedMethods),
      capability: false,
    },
  ]);
  if (compositionCollisions.length > 0) {
    throw new Error(
      `[codegen] pattern composition failed for '${entityName}':\n  ` +
      compositionCollisions.map((e) => e.message).join('\n  '),
    );
  }

  // The TS text a `queries:` finder prints beside the derivation's names (PLAN
  // §4.3), keyed by the DERIVED method name: per `by:` column its param type, the
  // return type, and the `order:` the body sorts by. Type text, not names —
  // slice 2 absorbs it.
  const queryTypes = Object.fromEntries(
    processedQueries.map((q) => [
      finderName(q),
      {
        params: q.params.map((p) => ({ tsType: p.tsType })),
        returnType: q.returnType,
        order: q.hasOrder ? { property: q.orderBy, direction: q.orderDirection } : null,
      },
    ]),
  );

  // The TS text a relation method prints beside the derivation's names, keyed
  // by the DERIVED method name and joined through the YAML declaration its
  // origin names: the target's class, the FK property a to-one reads, and the
  // composed repository it calls (`null`: its own, a self-reference).
  const relationTypes = {};
  for (const m of apiSurface.service.methods) {
    if (m.kind !== 'relation_one' && m.kind !== 'relation_many') continue;
    const [section, key] = m.origin.at.path;
    const dep = repositoryDeps.find((d) => d.entity === m.delegatesTo.entity);
    const repoProperty = m.delegatesTo.entity === entityName ? null : dep.property;
    if (m.kind === 'relation_one') {
      const rel = belongsTo.find((r) => (section === 'roles' ? r.role === key : r.name === key));
      relationTypes[m.name] = { targetClass: rel.relatedEntityPascal, fkProperty: rel.camelField, repoProperty };
    } else {
      const rel = hasMany.find((r) => r.name === key);
      relationTypes[m.name] = { relationship: rel.name, targetClass: rel.targetClass, repoProperty };
    }
  }

  const backendLocals = {
    // NAME-2 — emitted file stems (kebab-case). The `*Name*` locals beside
    // them stay snake_case: they are the class-name and DB-identifier source.
    entityFileStem,
    entityPluralFileStem,
    eavDefinitionEntityStem,
    eavDefinitionEntityPluralStem,
    eavFieldValuePluralStem,
    eavFieldValueStem,

    // backend identity
    entityName,
    entityNamePascal,
    entityNamePlural,
    entityNamePluralPascal,
    // TABLE-0: the SQL table name (pgTable argument); never a TS identifier.
    entityTableName,

    // Pattern — registry-driven (ADR-031)
    patternName,
    hasPatternConfig,
    patternConfig: patternConfigBlock,
    renderPatternConfigLiteral,
    // The one place a timestamp column's options are spelled (#796) — entity.ejs.t's behavior columns. The target's
    // text (TGT-1), so it comes from the pair's renderer.
    timestampColumn: columns.timestampColumn,
    ...patternConfigClasses,

    // Capability composition (ADR-041). `capabilityMixins` is empty for every
    // entity that declares no capability, and then `repositoryExtendsClause` is
    // exactly the string the template used to build inline.
    capabilityMixins,
    capabilityConfigImports,
    composedBaseClass,
    composedBaseImport,
    repositoryExtendsClause,
    composedBaseExtendsClause: composedBaseClass ? capabilityChain : null,

    // Integration write-surface (#374) — emitted only for pattern: Integrated. The
    // template hand-emits the integrationConfig literal (live refTable handles) +
    // TIntegrationWrite/TIntegrationProjection from these.
    hasIntegrationSurface: integrationSurface !== null,
    integrationConfig: integrationSurface?.integrationConfig ?? null,
    integrationFkResolvers: integrationSurface?.fkResolvers ?? [],
    integrationWriteFields: integrationSurface?.writeFields ?? [],
    integrationWriteFkFields: integrationSurface?.writeFkFields ?? [],
    integrationProjectionFields: integrationSurface?.projectionFields ?? [],
    integrationParentTableImports: integrationSurface?.parentTableImports ?? [],

    // Behavior flags (also exposed at top level for template use)
    hasTimestamps,
    hasSoftDelete,
    timestampsWithTimezone,
    softDeleteWithTimezone,
    hasUserTracking,
    hasExternalIdTracking,

    // Tenant scoping (ADR-042 / TEN-1; configurable column, #791)
    tenantScoped,
    tenantColumnEmitted,
    tenantColumnName: tenancy ? tenancy.column : null,
    tenantColumnProp: tenancy ? tenancy.prop : null,
    behaviorTenantColumn,

    // EAV (ADR-13)
    eavEnabled,
    eavFieldValueImportDir,
    eavFieldValueUseCaseImportDir,
    eavFieldValuePlural,
    eavFieldValueModulePascal,

    // EAV value-table (task #23) — this entity IS the value table.
    eavValueTable,
    eavDefinitionEntity,
    eavDefinitionEntityPlural,
    eavDefinitionImportDir,
    eavDefinitionPascal,
    eavDefinitionPluralPascal,
    // Search query (#16)
    searchQuery: searchQueryResolved,
    hasSearchQuery: !!searchQueryResolved,


    // #403: bounded-context segment (null when untagged). Drives the
    // module-folder nesting reflected in outputPaths above.
    context: entityContext,

    // REL-2 (#587): the two whole-set generated files the emitted repository and
    // controller import, relative to this entity's module folder.
    relationsImport,
    apiIncludesImport,
    typedEventBusImport,
    // Output paths
    outputPaths: outputPaths,
    // The DTO file stems the module's own index and of-kind file import (one owner: `dtoFileStem`).
    outputDtoStem: dtoFileStem(entityName, 'output'),
    ofKindDtoStem: dtoFileStem(entityName, 'ofKind'),

    // Architecture-specific imports (ADR-033.1 §8 — integration-source closes #267)
    imports,

    // Class names
    classNames,

    // Field data
    processedFields: nonFkFields,
    createDtoFields: createDtoFieldsWithZod,
    // ZOD-1a: the create fields whose chain applies a default; the update DTO restates them without it.
    updateDefaultOverrides: createDtoFieldsWithZod.filter((f) => f.createAppliesDefault),
    outputDtoFields: outputDtoFields,
    belongsTo: belongsTo,
    belongsToReference: (field) => {
      const reference = belongsToReferenceByField[field];
      if (reference === undefined) {
        throw new Error(`[codegen] '${entityName}': internal error — no .references() for belongs_to column '${field}'.`);
      }
      return reference;
    },
    belongsToFkFields: belongsToFkFields,
    createFkFields,

    // Drizzle
    drizzleImports: drizzleEntityImports,
    // drizzle-orm (not pg-core) value imports: `sql` when a partial unique renders a predicate (#784).
    drizzleOrmImports,
    tableColumns,
    // Every FK `references()` callback carries a `: AnyPgColumn` return-type
    // annotation (#631). An unannotated callback whose target table is on an
    // FK cycle with this one — a self-FK, or A → B → A across files — makes
    // TypeScript's strict mode flag the table const with TS7022/TS7024
    // (circular initializer). Annotating every callback is one rule with no
    // cycle detection; the annotation is type-only and does not change the
    // column's inferred type. `true` whenever this table has an FK column.
    // A `match:` relationship is a composite `foreignKey(...)`, not a `.references()`.
    hasFk: belongsTo.some((r) => !r.match) || fieldFeatures.hasFieldFk,
    enumFields,
    // The entity file imports its own enums from the leaf module and re-exports them (the schema barrel and
    // drizzle-kit read the entity file's exports).
    enumsImportSpecifier: `./${emittedStem(entityName)}.enums`,

    // Field-level foreign_key imports (#354) and pgTable extra-config
    // entries: single-column indexes (#355) + unique constraints (#356, #511,
    // #784: unique_indexes entries and field unique: true) + the
    // external_id_tracking unique.
    fieldFkImports,
    belongsToTableImports,
    tableConstraints,
    tableCallbackParam: T,

    // RFC-0006 (#875): joined-table inheritance and `match:` DDL.
    inheritanceImports,
    inheritedKeyColumns,
    matchDerivedColumns,
    isInheritanceChild: isChild,

    // ADR-046: the derived API surface, and the finder type text keyed by it
    apiSurface,
    queryTypes,
    relationTypes,

    // RFC-0006 (#875) S3: a family member's scope. Its read surface is `apiSurface.repository.methods` /
    // `.service.methods` (the derivation), not a flag here; the base-edge and kind-union text is keyed below.
    familyChild: family.child,
    // The constant names the repository and service share (`<EU>_BASE_KEYS`, `<EU>_CHILD_CREATE_PATH`, …): one derivation.
    familyConstName: (suffix) => familyConstName(entityName, suffix),
    familyHelperName: (suffix) => familyHelperName(entityName, suffix),
    familyBase: family.base,
    matchFills,
    naturalKey,
    // The child's tenant column (a copy of the base row's, written by the pair write), or null.
    childTenantProp: isChild && inheritedChild.tenant ? inheritedChild.tenant.prop : null,
    scopeTenantScoped,
    scopeTenantColumn,

    // Declarative queries
    processedQueries,
    hasDeclarativeQueries,
    hasMultiFieldQuery,
    hasOrderedQuery,
    hasViaQuery,

    // CGP-358b: has_many relationships for service-layer composition
    hasMany: hasMany,
    hasManyRelations: hasMany.length > 0,
    existingHasMany: hasMany.filter((r) => r.targetExists),

    // #632: every other entity's repository the service composes, once each
    repositoryDeps: repositoryDeps,
    repositoryDepModules,
    // JUNC-0 (#678): the junction fan-out this entity's service + module carry
    junctionFanOut: junctionFanOut,
    // The EAV definition repository is imported + injected by its own block
    // unless a relationship onto the same entity already put it in
    // `repositoryDeps`; either way the EAV methods address it by
    // `eavDefinitionRepoProperty` (one constructor parameter per class).
    eavDefinitionRepositoryImported: eavDefinitionDep != null,
    eavDefinitionRepoProperty: eavDefinitionDep ? eavDefinitionDep.property : 'definitionRepo',
  };
  assertNoUndefinedLocals(backendLocals, entity.name);
  // The complete local set the backend templates render with: the
  // prompt's own locals (banner, runtime import specifiers, EVT-7 emits, …)
  // plus the backend ones — what `prompt.js` holds after merging. No
  // prompt-owned local is defaulted here: a missing one is a ReferenceError in
  // the template (#638).
  return { ...baseLocals, ...backendLocals };
}

/**
 * A backend local set to `undefined` is a bug in this extension: the
 * template would treat it as falsy and silently emit nothing. `null` is a real
 * value (e.g. no composed base) and passes (#638).
 */
export function assertNoUndefinedLocals(locals, entityName) {
  const missing = Object.keys(locals).filter((k) => locals[k] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `backend locals for '${entityName}' are undefined: ${missing.sort().join(', ')}`,
    );
  }
}
