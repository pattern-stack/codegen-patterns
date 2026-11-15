/**
 * Joined-table inheritance and `match:` — the cross-entity half of the DDL
 * (RFC-0006 §2, #875).
 *
 * A table that is part of a family, or the target of a `match:`, is rendered
 * from MORE THAN ITS OWN YAML: a child's table reads its base's discriminator
 * and tenant column; a base (or any `match:` target) carries one
 * `unique(id, <cols>)` per column set its referrers' composite FKs point at.
 * Each such entity file is rendered by its OWN template from the other side's
 * YAML — the rule `junction-fan-out.mjs` follows — so `entity new` in any order
 * gives the same bytes (charter I2). Every cross-entity name comes from the
 * target's own YAML through `projectEntityLookup` (NAME-0), never from
 * `pluralize(name)`.
 *
 * This module is DATA: it returns what the entity template needs to render
 * (columns, constraints' parts, imports). `entity-locals.js` turns the parts
 * into `tableConstraints` entries, as it does for every other constraint.
 *
 * Readers: `templates/entity/new/backend/entity-locals.js`.
 */

import { camelCase, emittedStem } from '../../src/config/file-naming.js';
import { resolveChildTenancy, resolveTenancy } from '../../src/schema/tenancy.js';
import { entityClassName, repositoryClassName, routePath } from '../../src/derived/api/names.js';
import { baseOnlyKinds, enumChoices, familyRelationKey, inheritanceChildrenOf, inheritsOf, matchPairsOf } from '../../src/schema/inheritance.js';
import { entityModuleNaming, relativeModuleDir } from './entity-naming.mjs';

/**
 * The pg type name and the exported `pgEnum` const of an enum field —
 * namespaced by the OWNING entity so two entities' same-named enums never
 * collide (`communication_kind` / `communicationKindEnum`). `processFields` and
 * every importer of an enum read this one rule.
 */
export function enumTypeNames(entityName, fieldName) {
  const dbName = entityName ? `${entityName}_${fieldName}` : fieldName;
  return { dbName, enumName: `${camelCase(dbName)}Enum` };
}

function requireDefinition(lookup, name, why) {
  const def = lookup?.definition ? lookup.definition(name) : null;
  if (!def) {
    const missing = lookup?.missingEntity ? lookup.missingEntity(name) : 'no entity lookup was supplied';
    throw new Error(`[codegen] ${why}: '${name}' has no entity YAML — ${missing}.`);
  }
  return def;
}

/**
 * Where an entity's emitted module lives, as seen from `fromNaming`'s module
 * folder: its table export, and the import specifier of its `.entity` file.
 */
function moduleRef(lookup, fromNaming, modulesDir, name, why) {
  const block = lookup?.(name);
  if (!block) {
    const missing = lookup?.missingEntity ? lookup.missingEntity(name) : 'no entity lookup was supplied';
    throw new Error(`[codegen] ${why}: '${name}' has no entity YAML — ${missing}.`);
  }
  const naming = entityModuleNaming(block, modulesDir);
  const dir = relativeModuleDir(fromNaming.moduleDir, naming.moduleDir);
  return {
    plural: naming.plural,
    // The target's module folder as seen from the importing file, and its file stem: the writes (S4) import
    // its repository and its module as well as its entity file.
    dir,
    stem: emittedStem(name),
    pluralStem: emittedStem(naming.plural),
    importPath: `${dir}/${emittedStem(name)}.entity`,
    // The owner's enum LEAF module (imports only pg-core): an enum is called at module top level, so it is never
    // imported from the entity file, which sits in a cycle with its children and referrers.
    enumsImportPath: `${dir}/${emittedStem(name)}.enums`,
  };
}

/**
 * The enum a field's column is typed with: this entity's own `pgEnum`, or — for
 * `choices_of: <entity>.<field>` — the OWNER's (Postgres will not build an FK
 * between two enum types, RFC-0006 §2.4). `null` when the field is not an enum.
 * `importPath` is the owner's `.enums` leaf module as seen from `fromNaming`'s folder.
 *
 * `choices_of:` follows exactly one hop (S1 refuses a chain).
 */
export function resolveEnumField({ lookup, modulesDir, fromNaming, entityName, fieldName, field }) {
  if (!field) return null;
  if (field.choices_of !== undefined) {
    const [ownerName, ownerField] = String(field.choices_of).split('.');
    const ownerDef = requireDefinition(lookup, ownerName, `'${entityName}.${fieldName}' choices_of '${field.choices_of}'`);
    // The choices come from the ONE resolver (`enumChoices`); this function adds the owner's names and import path.
    const choices = enumChoices(field, (name) => (name === ownerName ? ownerDef : undefined));
    if (choices === undefined) {
      throw new Error(
        `[codegen] '${entityName}.${fieldName}' choices_of '${field.choices_of}': '${ownerName}.${ownerField}' is not an enum field with literal choices.`,
      );
    }
    const names = enumTypeNames(ownerName, ownerField);
    const ref = moduleRef(lookup, fromNaming, modulesDir, ownerName, `'${entityName}.${fieldName}' choices_of '${field.choices_of}'`);
    return {
      ownerEntity: ownerName,
      choices,
      enumName: names.enumName,
      dbName: names.dbName,
      importPath: ref.enumsImportPath,
    };
  }
  const choices = enumChoices(field, () => undefined);
  if (choices !== undefined) {
    const names = enumTypeNames(entityName, fieldName);
    const ref = moduleRef(lookup, fromNaming, modulesDir, entityName, `'${entityName}.${fieldName}'`);
    return {
      ownerEntity: entityName,
      choices,
      enumName: names.enumName,
      dbName: names.dbName,
      importPath: ref.enumsImportPath,
    };
  }
  return null;
}

/** The SQL type identity the derived column of a `match:` takes from its target column. */
function targetColumnField(targetDef, targetName, column, relName, entityName) {
  const field = targetDef.fields?.[column];
  if (field) return { kind: 'field', field };
  for (const rel of Object.values(targetDef.relationships ?? {})) {
    if (rel?.type === 'belongs_to' && rel.foreign_key === column) return { kind: 'fk' };
  }
  throw new Error(
    `[codegen] '${entityName}' relationship '${relName}': match target column '${targetName}.${column}' is not a declared field or foreign key column of '${targetName}'.`,
  );
}

/**
 * Every `belongs_to` with a `match:` that points at `targetName`, across the
 * whole entity set: the referrers whose composite FKs need a unique on the
 * target. `[{ referrer, relName, rel, pairs }]`, in lookup order.
 */
export function matchReferrers(lookup, targetName) {
  const out = [];
  if (!lookup?.definitions) {
    throw new Error(
      `[codegen] a \`match:\` referrer scan for '${targetName}' needs an entity lookup (none was supplied); ` +
        `a hand-built local set passes \`entityLookupFrom([])\`.`,
    );
  }
  for (const def of lookup.definitions()) {
    for (const [relName, rel] of Object.entries(def.relationships ?? {})) {
      if (rel?.type !== 'belongs_to' || rel.target !== targetName) continue;
      const pairs = matchPairsOf(rel);
      if (pairs.length > 0) out.push({ referrer: def.entity.name, relName, rel, pairs });
    }
  }
  return out;
}

/**
 * What the entity template needs for the inheritance half of one entity's DDL.
 *
 * @param {object} p
 * @param {string} p.entityName
 * @param {object} p.definition        this entity's parsed YAML
 * @param {Function} p.lookup          `projectEntityLookup` (with `.definition` / `.definitions`)
 * @param {object} p.ownNaming         `entityModuleNaming` of this entity
 * @param {string} p.modulesDir
 * @param {string} p.tenancyColumn     the project's `tenancy.column`
 *
 * @returns {{
 *   child: null | {
 *     base: string, as: string, baseTable: string,
 *     baseImportPath: string, kind: {column,prop,enumName,importPath,ownerEntity,dbName},
 *     discriminator: string, tenant: null | {column, prop},
 *   },
 *   uniqueTargets: Array<{ columns: string[] }>,  // unique(id, ...columns), deduplicated by column set
 * }}
 */
export function inheritanceFor({
  entityName,
  definition,
  lookup,
  ownNaming,
  modulesDir,
  tenancyColumn,
}) {
  const declaration = inheritsOf(definition);
  let child = null;

  if (declaration !== null) {
    const why = `'${entityName}' inherits '${declaration.base}'`;
    const baseDef = requireDefinition(lookup, declaration.base, why);
    const discriminator = baseDef.discriminator;
    if (typeof discriminator !== 'string') {
      throw new Error(`[codegen] ${why}, which declares no 'discriminator:'.`);
    }
    const baseRef = moduleRef(lookup, ownNaming, modulesDir, declaration.base, why);
    const kindEnum = resolveEnumField({
      lookup,
      modulesDir,
      fromNaming: ownNaming,
      entityName: declaration.base,
      fieldName: discriminator,
      field: baseDef.fields?.[discriminator],
    });
    if (kindEnum === null) {
      throw new Error(`[codegen] ${why}: discriminator '${discriminator}' is not an enum field with known choices.`);
    }
    const tenancy = resolveChildTenancy(declaration.base, baseDef, tenancyColumn);
    child = {
      base: declaration.base,
      as: declaration.as,
      baseTable: baseRef.plural,
      baseImportPath: baseRef.importPath,
      discriminator,
      kind: {
        column: discriminator,
        prop: camelCase(discriminator),
        enumName: kindEnum.enumName,
        dbName: kindEnum.dbName,
        ownerEntity: kindEnum.ownerEntity,
        importPath: kindEnum.importPath,
      },
      tenant: tenancy === null ? null : { column: tenancy.column, prop: tenancy.prop },
    };
  }

  // The unique(id, …) targets this entity must offer: its own discriminator
  // (every child's kind FK points at it) and every `match:` column set a
  // referrer's composite FK points at — one unique per column SET.
  const sets = new Map();
  const addSet = (cols) => {
    const key = [...cols].sort().join(',');
    if (!sets.has(key)) sets.set(key, { columns: cols });
  };
  if (typeof definition.discriminator === 'string') {
    addSet([definition.discriminator]);
    // ...and, for a tenant-scoped base, the tenant column set every child's tenant FK points at. It goes through
    // the same set as a `match:` onto the tenant column, so the two can never emit one constraint twice.
    const tenancy = resolveTenancy(entityName, definition, tenancyColumn);
    if (tenancy !== null) addSet([tenancy.column]);
  }
  for (const { pairs } of matchReferrers(lookup, entityName)) addSet(pairs.map(([, target]) => target));
  const uniqueTargets = [...sets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);

  return { child, uniqueTargets };
}

/**
 * The derived local columns and composite FKs of this entity's `match:`
 * relationships (RFC-0006 §2.4).
 *
 * `existing` are the columns the table already emits under that name (its own
 * discriminator and declared fields — M2's exception): a match on one of those derives nothing,
 * and the FK uses the declared column. (A match on a child's carried kind / tenant is refused by M2,
 * so it never reaches here; the set is a defensive superset.)
 * Two relationships matching one local column share ONE derived column (M3).
 * `nullableByRel` is each relationship's resolved FK nullability (`processBelongsTo`):
 * the derived column is NOT NULL unless EVERY relationship matching it is nullable.
 *
 * @returns {{
 *   derived: Array<{ column: string, targetEntity: string, targetColumn: string, nullable: boolean,
 *                    kind: 'fk'|'field', field?: object, enumRef: object|null }>,
 *   fks: Array<{ relName: string, rel: object, pairs: Array<[string,string]> }>,
 * }}
 */
export function matchColumns({ entityName, relationships, lookup, existing, nullableByRel, modulesDir, fromNaming }) {
  const derived = [];
  const byLocal = new Map();
  const fks = [];
  for (const [relName, rel] of Object.entries(relationships ?? {})) {
    if (rel?.type !== 'belongs_to') continue;
    const pairs = matchPairsOf(rel);
    if (pairs.length === 0) continue;
    fks.push({ relName, rel, pairs });
    const targetDef = requireDefinition(lookup, rel.target, `'${entityName}' relationship '${relName}' (match:)`);
    for (const [local, targetColumn] of pairs) {
      if (existing.has(local)) continue;
      const fkNullable = nullableByRel.get(relName) === true;
      const prior = byLocal.get(local);
      // One derived column, however many relationships match it (M3): it is NOT NULL as soon as ANY of them is.
      // A NULL in a composite FK's columns skips the check (MATCH SIMPLE), so a nullable column shared with a
      // NOT NULL FK would silently disable that FK's rule.
      if (prior !== undefined) {
        prior.nullable = prior.nullable && fkNullable;
        continue;
      }
      const t = targetColumnField(targetDef, rel.target, targetColumn, relName, entityName);
      const entry = {
        column: local,
        targetEntity: rel.target,
        targetColumn,
        nullable: fkNullable,
        // An enum column is typed with the pgEnum its target column is typed with.
        enumRef:
          t.kind === 'field'
            ? resolveEnumField({ lookup, modulesDir, fromNaming, entityName: rel.target, fieldName: targetColumn, field: t.field })
            : null,
        ...t,
      };
      byLocal.set(local, entry);
      derived.push(entry);
    }
  }
  return { derived, fks };
}

/**
 * What the READ surface of a joined-table family needs (RFC-0006 §3, §6; S3).
 *
 * `child` — this entity inherits: the relation key of its base edge, the base's
 * table export and entity file, and which of the base's lifecycle behaviors
 * reach it through `baseScope` (the child declares none, R5). `baseBehaviors` is
 * the BASE's resolved behavior names (declared plus pattern-implied), computed by
 * the caller the way the base's own repository computes them.
 *
 * `base` — this entity declares `discriminator:`: its kinds, and each child
 * (found across the whole entity set, never by pluralizing): the kind value it
 * is `as`, its relation key on the base, its table export and the type's import.
 *
 * @returns {{
 *   child: null | { relKey: string, baseTable: string, baseImportPath: string,
 *                   baseScope: null | { softDelete: boolean, userTracking: boolean },
 *                   as: string, baseName: string, baseClass: string, baseRepositoryClass: string,
 *                   baseRepositoryImportPath: string, baseModuleDir: string,
 *                   discriminatorProp: string, baseTimestamps: boolean },
 *   base: null | { discriminator: string, discriminatorProp: string, kinds: string[],
 *                  children: Array<{ as: string, name: string, relKey: string, plural: string,
 *                                    className: string, entityImportPath: string, createPath: string }> },
 * }}
 */
export function familyReads({ entityName, definition, lookup, ownNaming, modulesDir, baseBehaviors }) {
  const declaration = inheritsOf(definition);
  let child = null;
  if (declaration !== null) {
    const why = `'${entityName}' inherits '${declaration.base}'`;
    const ref = moduleRef(lookup, ownNaming, modulesDir, declaration.base, why);
    const softDelete = baseBehaviors.includes('soft_delete');
    const userTracking = baseBehaviors.includes('user_tracking');
    const baseDef = requireDefinition(lookup, declaration.base, why);
    const baseClass = entityClassName(declaration.base);
    child = {
      relKey: familyRelationKey(declaration.base),
      baseTable: ref.plural,
      baseImportPath: ref.importPath,
      baseScope: softDelete || userTracking ? { softDelete, userTracking } : null,
      // S4 — the pair write: the kind this child writes, and the base's repository and module (the child's
      // repository injects the base repository; its module imports the base's module).
      as: declaration.as,
      baseName: declaration.base,
      baseClass,
      discriminatorProp: camelCase(baseDef.discriminator),
      baseRepositoryClass: repositoryClassName(declaration.base),
      baseRepositoryImportPath: `${ref.dir}/${ref.stem}.repository`,
      baseModuleDir: ref.dir,
      baseTimestamps: baseBehaviors.includes('timestamps'),
      // S5 — the flat DTOs (their paths are as seen from `<module>/dto/`): the base's schemas are the owner, the child extends them (RFC-0006 §5).
      // The same entity file as seen from a file one folder deeper (`dto/`, `use-cases/`).
      baseImportPathFromSubdir: `../${ref.importPath}`,
      baseCreateSchema: `Create${baseClass}Schema`,
      baseCreateImportPath: `../${ref.dir}/dto/${emittedStem('create', declaration.base)}.dto`,
      baseOutputSchema: `${baseClass}OutputSchema`,
      baseOutputImportPath: `../${ref.dir}/dto/${emittedStem(declaration.base, 'output')}.dto`,
    };
  }

  let base = null;
  if (typeof definition.discriminator === 'string') {
    const field = definition.fields?.[definition.discriminator];
    const enumRef = resolveEnumField({
      lookup,
      modulesDir,
      fromNaming: ownNaming,
      entityName,
      fieldName: definition.discriminator,
      field,
    });
    if (enumRef === null) {
      throw new Error(`[codegen] '${entityName}': discriminator '${definition.discriminator}' is not an enum field with known choices.`);
    }
    if (!lookup?.definitions) {
      throw new Error(`[codegen] '${entityName}' declares discriminator '${definition.discriminator}', but no entity lookup was supplied to find its children.`);
    }
    const children = inheritanceChildrenOf(entityName, lookup.definitions()).map((c) => {
      const ref = moduleRef(lookup, ownNaming, modulesDir, c.name, `'${c.name}' inherits '${entityName}'`);
      return {
        as: c.as,
        name: c.name,
        relKey: familyRelationKey(c.name),
        plural: ref.plural,
        className: entityClassName(c.name),
        entityImportPath: ref.importPath,
        // The create route a write through the base is told to use for this kind (KindRequiresChildError): the child's POST.
        createPath: `POST ${routePath(ref.plural)}`,
        // S5 — the child's own columns as an output schema (nested under its kind key in `<Base>OfKindSchema`).
        ownOutputSchema: `${entityClassName(c.name)}OwnOutputSchema`,
        outputImportPath: `../${ref.dir}/dto/${emittedStem(c.name, 'output')}.dto`,
      };
    });
    base = {
      discriminator: definition.discriminator,
      discriminatorProp: camelCase(definition.discriminator),
      kinds: enumRef.choices,
      children,
      // The kinds with no child table: the only ones the base's own create accepts (RFC-0006 §4.1, §5).
      baseOnlyKinds: baseOnlyKinds(enumRef.choices, children.map((c) => c.as)),
    };
  }
  return { child, base };
}
