/**
 * Hygen prompt.js — Loads junction YAML and prepares template locals
 *
 * Usage: bunx hygen junction new --yaml junctions/opportunity_contact.yaml
 *
 * Mirrors templates/relationship/new/prompt.js but adapted for junction
 * definitions (two endpoints, role enum, BaseJunctionFields, composite PK,
 * no controller/DTOs/use-cases). The parents' fan-out onto this junction is
 * rendered by their own templates (templates/_shared/junction-fan-out.mjs,
 * JUNC-0 #678) — this generator writes only the junction's own files.
 *
 * Output paths are the backend module tree (`paths.modules_dir`) — the
 * only backend pipeline (ARCH-0, #677).
 */

import fs from "node:fs";
import path from "node:path";
import { emittedStem } from '../../../src/config/file-naming.js';
import yaml from "yaml";
import { behaviorWithTimezone, timestampColumn } from "../../../src/schema/field-timestamp.js";
import { JunctionDefinitionSchema, hasIdentityRole } from "../../../src/schema/junction-definition.schema.js";
import { renderGeneratedBanner } from "../../_shared/generated-banner.mjs";
import {
  junctionName as deriveJunctionName,
  junctionLinkInput,
  junctionNaming,
} from "../../_shared/junction-fan-out.mjs";
import {
  entityModuleNaming,
  projectEntityLookup,
  relativeModuleDir,
} from "../../_shared/entity-naming.mjs";
import { loadRuntimeMode, runtimeImport } from "../../../src/config/runtime-mode.mjs";
import { processFieldFeatures, processFields } from "../../entity/new/backend/entity-locals.js";
import { loadOwnedTableNames } from "../../entity/new/prompt.js";
import { configOrDefaults, loadProjectConfig } from "../../../src/config/project-config.js";
import { junctionTableName } from "../../../src/config/junction-naming.js";

// ============================================================================
// Naming Helpers (inlined to avoid import issues with Hygen)
// ============================================================================

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const camelCase = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const pascalCase = (s) => capitalize(camelCase(s));

// ============================================================================
// Config Loading Helpers
// ============================================================================

// The parsed config, or the schema's defaults with no file (PATH-0, #642):
// `paths.modules_dir` has ONE default, declared in `codegen-config.schema.ts` —
// this prompt carries none of its own.

// ============================================================================
// Name Derivation
// ============================================================================

// The junction's name and table / folder plural come from the one junction
// naming rule (`junctionNaming`, templates/_shared/junction-fan-out.mjs,
// JUNC-0) — the rule the parents' fan-out reads too. No YAML override: this
// file parses raw YAML, but `codegen junction new` validates every file through
// the `.strict()` JunctionDefinitionSchema — which declares neither `name` nor
// `table` — before handing it to hygen (GATE-1, #599).

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

function buildDrizzleImports(hasRole, processedCustomFields, hasIndexes) {
  // The base set is what the fixed columns can use; it is not narrowed per
  // opt-out so a default junction's import list stays as it was.
  const needed = new Set(["pgTable", "primaryKey", "uuid", "timestamp", "boolean", "numeric", "text"]);
  if (hasRole) needed.add("pgEnum");
  for (const f of processedCustomFields) {
    if (f.hasChoices) needed.add("pgEnum");
    else needed.add(f.drizzleType);
  }
  if (hasIndexes) needed.add("index");
  return Array.from(needed).sort();
}

// ============================================================================
// Payload Field Processing
// ============================================================================

// Payload fields are entity fields (#740): `JunctionDefinitionSchema` parses
// them against `FieldDefinitionSchema`, and they are rendered by the entity
// column builder (`processFields` → `drizzleChain`, `processFieldFeatures` →
// `.references()` + `index: true`) — one owner for nullability, defaults,
// enums, FKs and indexes. Nothing here re-derives a column.
function processPayloadFields(fields, junctionName, naming, ownedTables) {
  const processed = processFields(fields, junctionName);
  const features = processFieldFeatures(processed, fields, naming, ownedTables, new Set());
  return { processed, ...features };
}

// ============================================================================
// Output Path Resolution
// ============================================================================

function resolveOutputPaths(junction) {
  return {
    entity:     `${junction.entityFile}.ts`,
    repository: junction.repositoryFile,
    service:    junction.serviceFile,
    module:     junction.moduleFile,
    index:      `${junction.moduleDir}/index.ts`,
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

    // The schema is the one owner of what a junction may declare — payload
    // fields included (#740). `codegen junction new` runs it before hygen;
    // running it here too keeps a direct hygen call from rendering a YAML the
    // CLI would refuse. The raw definition is what the locals below read.
    const parsed = JunctionDefinitionSchema.safeParse(definition);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => {
        const [head, field] = issue.path;
        return head === "fields" && typeof field === "string"
          ? `junction field '${field}': ${issue.message}`
          : `${issue.path.join(".") || "(root)"}: ${issue.message}`;
      });
      throw new Error(`[codegen] ${yamlPath}: ${issues.join("; ")}`);
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

    const config_ = configOrDefaults(loadProjectConfig(cwd));
    // #845: the time columns the junction itself emits (created_at /
    // updated_at, and the BaseJunctionFields started_at / ended_at /
    // matched_at) follow the project's `behaviors.timezone` — the one rule
    // (`behaviorWithTimezone`) entity behavior columns use. A junction has no
    // `behaviors:` list, so the project default decides. A declared datetime
    // payload field keeps its own `timezone:`.
    const generatedTimeWithTimezone = behaviorWithTimezone([], "timestamps", config_.behaviors.timezone);
    const modulesDir = config_.paths.modules_dir;
    const junctionName = deriveJunctionName(config.between);
    const junction = junctionNaming(junctionName, modulesDir);
    // TABLE-0: the SQL table name (`pgTable('…')`) — `junctionTableName`, the
    // one rule over the junction YAML's `table` / `table_prefix` and the
    // project's `tables.prefix`. The export, folder and classes stay on the
    // plural derived from `between:`.
    const tableName = junctionTableName(config, config_.tables.prefix);
    const entityNamePascal = pascalCase(junctionName);
    const entityNameCamel = camelCase(junctionName);
    const entityNamePlural = junction.plural;
    const tableVarName = camelCase(entityNamePlural);
    const entityNamePluralPascal = pascalCase(entityNamePlural);
    // NAME-2 — emitted file stems (kebab). `junctionName` / `entityNamePlural`
    // stay snake: they are the class-name and export source.
    const entityFileStem = emittedStem(junctionName);
    const entityPluralFileStem = emittedStem(entityNamePlural);

    // ======================================================================
    // Pairing endpoints
    // ======================================================================

    const leftEntity = config.between[0];   // e.g. 'opportunity'
    const rightEntity = config.between[1];  // e.g. 'contact'
    const leftEntityPascal = pascalCase(leftEntity);
    const rightEntityPascal = pascalCase(rightEntity);

    // FK column names (same derivation as relationship — no self-referential
    // prefix needed since between[] endpoints must be distinct per schema)
    const leftColumn = `${leftEntity}_id`;
    const rightColumn = `${rightEntity}_id`;
    const leftColumnCamel = camelCase(leftColumn);
    const rightColumnCamel = camelCase(rightColumn);

    // ======================================================================
    // Role enum
    // ======================================================================

    // `role` is the identity enum only when it has `choices:`; otherwise it is
    // an ordinary payload column (below) — never dropped.
    const hasRole = hasIdentityRole(fields);
    const roleChoices = hasRole ? fields.role.choices : undefined;
    const roleEnumName = hasRole ? `${entityNameCamel}RoleEnum` : null;
    const roleEnumValues = hasRole ? roleChoices : [];

    // ======================================================================
    // BaseJunctionFields gating (opt-outs per Q4 / #58 resolution)
    // ======================================================================

    // The base-column flags as the schema resolved them — it owns their defaults.
    const { temporal, sourced, is_primary: isPrimary, timestamps } = parsed.data;

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
    if (hasRole) delete otherFields.role; // the identity role is the role enum above
    const entityLookup = projectEntityLookup(cwd);
    const payload = processPayloadFields(
      otherFields,
      junctionName,
      // TABLE-0: a payload index / self-FK names the junction's SQL table.
      { entityName: junctionName, ownNaming: junction, entityTableName: tableName, modulesDir, entityLookup },
      Array.from(loadOwnedTableNames(cwd, { tablePrefix: config_.tables.prefix })),
    );
    const processedCustomFields = payload.processed;
    const hasCustomFields = processedCustomFields.length > 0;
    const payloadIndexes = payload.indexExpressions;

    // ======================================================================
    // Drizzle imports
    // ======================================================================

    const drizzleImports = buildDrizzleImports(hasRole, processedCustomFields, payloadIndexes.length > 0);

    // ======================================================================
    // Output paths
    // ======================================================================

    const outputPaths = resolveOutputPaths(junction);

    // The service's `LinkInput` — the link-side columns a caller supplies on
    // attach: the base columns this junction emits, the identity role and the
    // payload fields, `required: true` ones required (`junctionLinkInput`, the
    // reader the parents' fan-out shares).
    const linkInput = junctionLinkInput(definition);
    const keyUnion = (keys) => keys.map((k) => `'${k}'`).join(' | ');
    const linkInputKeys = linkInput.optional.length > 0 ? keyUnion(linkInput.optional) : 'never';
    const linkInputRequiredKeys = linkInput.required.length > 0 ? keyUnion(linkInput.required) : null;

    // REL-2 (#587): the generated relation manifest, imported by the junction
    // repository to bind `BaseRepository`'s third type parameter. Relative to the
    // repository's own directory, and resolved through `paths.generated` so a
    // project that moves the generated dir still compiles.
    const generatedDirRel = config_?.paths?.generated || 'src/generated';
    const relationsImport = (() => {
      const spec = path.posix.relative(
        path.posix.dirname(path.posix.normalize(outputPaths.repository)),
        path.posix.normalize(`${generatedDirRel}/relations`),
      );
      return spec.startsWith('.') ? spec : `./${spec}`;
    })();

    // ======================================================================
    // Endpoint naming — from each endpoint's OWN YAML (NAME-0, #611)
    // ======================================================================
    // The table export and module folder of an endpoint are its `plural:` and
    // `context:`, read through the same function its own emission uses — never
    // `pluralize(name)` here.
    const endpointNaming = (endpoint) => {
      const block = entityLookup(endpoint);
      if (!block) {
        throw new Error(
          `[junction/new] ${yamlPath}: endpoint '${endpoint}' has no entity YAML — ` +
          `${entityLookup.missingEntity(endpoint)}. The junction reads its table and module folder from that YAML.`
        );
      }
      return entityModuleNaming(block, modulesDir);
    };
    const leftNaming = endpointNaming(leftEntity);
    const rightNaming = endpointNaming(rightEntity);
    const leftEntityPlural = leftNaming.plural;
    const rightEntityPlural = rightNaming.plural;

    // Drizzle variable names for the parent tables (used in FK .references())
    const leftTable = leftEntityPlural;   // e.g. 'opportunities'
    const rightTable = rightEntityPlural; // e.g. 'contacts'

    // The junction's own folder is flat (a junction has no `context:`).
    const junctionModuleDir = junction.moduleDir;

    // Import specifiers from the junction's folder to each endpoint's entity,
    // repository and module files — relative paths to the files the endpoint's
    // own naming names (`entityModuleNaming`, NAME-2), so the stems are the
    // emitted kebab ones and an endpoint nested under a `context:` gets the
    // extra segment. Never `${endpoint}.entity` by hand: a multi-word endpoint
    // emits `fantasy-team.entity`, not `fantasy_team.entity` (#730).
    // (The parents' side — their fan-out onto this junction — is rendered by
    // their own templates: templates/_shared/junction-fan-out.mjs, JUNC-0.)
    const importFromJunction = (file) =>
      `${relativeModuleDir(junctionModuleDir, path.posix.dirname(file))}/${path.posix.basename(file).replace(/\.ts$/, '')}`;

    // Left/right repo + entity + module import paths from the junction's
    // perspective (used by service.ejs.t to import target repos, entity.ejs.t
    // for the FK tables and module.ejs.t to import the parent modules).
    const leftRepoImportFromJunction = importFromJunction(leftNaming.repositoryFile);
    const rightRepoImportFromJunction = importFromJunction(rightNaming.repositoryFile);
    const leftEntityImportFromJunction = importFromJunction(leftNaming.entityFile);
    const rightEntityImportFromJunction = importFromJunction(rightNaming.entityFile);
    const leftModuleImportFromJunction = importFromJunction(leftNaming.moduleFile);
    const rightModuleImportFromJunction = importFromJunction(rightNaming.moduleFile);

    // Parent module + repository class names.
    const leftRepositoryClass = `${leftEntityPascal}Repository`;
    const rightRepositoryClass = `${rightEntityPascal}Repository`;
    const leftModuleClass = `${pascalCase(leftEntityPlural)}Module`;
    const rightModuleClass = `${pascalCase(rightEntityPlural)}Module`;

    // Camel forms of left/right entity names for use in method signatures
    // (e.g. attach(opportunityId, contactId)).
    const leftEntityCamel = camelCase(leftEntity);
    const rightEntityCamel = camelCase(rightEntity);

    // ======================================================================
    // Inbound-integration write surface (#374)
    // ======================================================================
    // The junction integration identity is the tuple (leftId, rightId[, role]); its
    // externalId is a COMPOSITE string. Both parent FKs resolve strictly. FK
    // write-keys use `${camelCase(entity)}ExternalId` (matches the reference).

    const leftIntegrationWriteKey = `${leftEntityCamel}ExternalId`;
    const rightIntegrationWriteKey = `${rightEntityCamel}ExternalId`;
    const roleColumnCamel = hasRole ? 'role' : null;
    // Role TS type — literal union from the enum choices, else absent.
    const roleTsType = hasRole
      ? roleChoices.map((c) => `'${c}'`).join(' | ')
      : null;

    // JunctionIntegrationConfig literal fields. refTable is emitted as a live table
    // identifier (leftTable/rightTable) by the template.
    const integrationConfig = {
      leftColumn: leftColumnCamel,
      leftRefTable: leftTable,
      rightColumn: rightColumnCamel,
      rightRefTable: rightTable,
      roleColumn: roleColumnCamel,
    };

    // TIntegrationWrite fields: both parent external ids + optional role + userId.
    const integrationWriteFields = [
      { name: leftIntegrationWriteKey, tsType: 'string' },
      { name: rightIntegrationWriteKey, tsType: 'string' },
      ...(hasRole ? [{ name: 'role', tsType: roleTsType }] : []),
      { name: 'userId', tsType: 'string' },
    ];

    // TIntegrationProjection fields: composite id + local FK columns + optional role +
    // timestamps. No surrogate id column on a junction.
    const integrationProjectionFields = [
      { name: 'id', tsType: 'string' },
      { name: leftColumnCamel, tsType: 'string' },
      { name: rightColumnCamel, tsType: 'string' },
      ...(hasRole ? [{ name: 'role', tsType: roleTsType }] : []),
      ...(timestamps
        ? [{ name: 'createdAt', tsType: 'Date' }, { name: 'updatedAt', tsType: 'Date' }]
        : []),
    ];

    // Parent-table imports for the FK resolvers, deduped (#368). Junction
    // endpoints are distinct by schema, so two imports unless they collide.
    const integrationParentImports = [];
    const seenIntegrationImports = new Set();
    for (const imp of [
      { table: leftTable, importPath: leftEntityImportFromJunction },
      { table: rightTable, importPath: rightEntityImportFromJunction },
    ]) {
      if (seenIntegrationImports.has(imp.table)) continue;
      seenIntegrationImports.add(imp.table);
      integrationParentImports.push(imp);
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

    // Package-owned runtime imports resolve by `runtime:` mode (ADR-037, #624)
    // through the entity pipeline's resolver: `@shared/<relpath>` vendored,
    // `@pattern-stack/codegen/runtime/<relpath>` under the package default.
    // `@shared/database/database.module` is consumer-local in both modes.
    const runtimeMode = loadRuntimeMode(cwd);
    const drizzleTokenImport = runtimeImport(runtimeMode, 'constants/tokens');
    const drizzleTypeImport = runtimeImport(runtimeMode, 'types/drizzle');
    const junctionIntegrationRepositoryImport = runtimeImport(
      runtimeMode,
      'base-classes/junction-integration-repository',
    );
    const withAnalyticsImport = runtimeImport(runtimeMode, 'base-classes/with-analytics');
    const baseServiceImport = runtimeImport(runtimeMode, 'base-classes/base-service');

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

      // Runtime-mode import specifiers (#624)
      drizzleTokenImport,
      drizzleTypeImport,
      junctionIntegrationRepositoryImport,
      withAnalyticsImport,
      baseServiceImport,

      // Identity
      name: junctionName,
      entityNamePascal,
      entityNameCamel,
      entityNamePlural,
      entityFileStem,
      entityPluralFileStem,
      entityNamePluralPascal,
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
      isPrimary,
      timestamps,
      linkInputKeys,
      linkInputRequiredKeys,

      // On-delete
      onDeleteLeft,
      onDeleteRight,

      // Custom fields
      processedCustomFields,
      timestampColumn,
      generatedTimeWithTimezone,
      hasCustomFields,
      payloadIndexes,
      // Tables a payload `foreign_key:` references, minus the two endpoint
      // tables the entity file already imports.
      payloadFkImports: payload.fkImports.filter(
        (imp) => imp.relatedTable !== leftTable && imp.relatedTable !== rightTable,
      ),

      // Drizzle
      drizzleImports,

      // Output paths
      outputPaths,

      // Class names
      classNames,

      // REL-2 (#587): the relation manifest specifier for this repository file.
      relationsImport,

      // Parent table Drizzle var names (for FK .references())
      leftTable,
      rightTable,

      // ──────────────────────────────────────────────────────────────────
      // Inbound-integration write surface (#374)
      // ──────────────────────────────────────────────────────────────────
      leftIntegrationWriteKey,
      rightIntegrationWriteKey,
      roleColumnCamel,
      roleTsType,
      junctionIntegrationConfig: integrationConfig,
      integrationWriteFields,
      integrationProjectionFields,
      integrationParentImports,

      // ──────────────────────────────────────────────────────────────────
      // Endpoint locals for the junction's own service + module
      // ──────────────────────────────────────────────────────────────────
      // Camel-case forms of endpoint names (used in method param names).
      leftEntityCamel,
      rightEntityCamel,
      // Parent-side repo + entity + module import paths from the junction's
      // perspective (used by junction service.ejs.t + module.ejs.t).
      leftRepoImportFromJunction,
      rightRepoImportFromJunction,
      leftEntityImportFromJunction,
      rightEntityImportFromJunction,
      leftModuleImportFromJunction,
      rightModuleImportFromJunction,
      // Class names used by the service + module templates.
      leftRepositoryClass,
      rightRepositoryClass,
      leftModuleClass,
      rightModuleClass,
    };
  },
};
