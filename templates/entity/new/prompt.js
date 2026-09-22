/**
 * Hygen prompt.js - Loads entity YAML and prepares template locals
 *
 * Usage: bunx hygen entity new --yaml entities/opportunity.yaml
 *
 * backend is the only backend pipeline (ARCH-0, #677), and
 * `backend/entity-locals.js` builds almost every local it reads from
 * the parsed YAML itself. What is left here is the handful of locals the
 * extension does NOT build: the `@generated` banner, the runtime-mode import
 * specifiers, the `detection:` literal, and the EVT-7 `emits:` descriptors.
 *
 * ARCH-1 (#682) deleted the other 69 locals this file used to export — layout,
 * paths, fileNames, imports, backendLayers, locations, *CommandClass,
 * behaviorStrategy, expose*, the field / relationship / query / event passes
 * behind them — together with the config surface that fed them (`naming:`,
 * `database:`, `behaviors:`, `locations.backend*`, the entity layout keys).
 * Every one was measured dead: no backend template and no
 * `prompt-extension.js` read it. See `docs/specs/ARCH-1.md`.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import pluralizePkg from "pluralize";
import { BASE_PATHS, getGeneratedDir, getProjectConfig } from "../../../src/config/paths.mjs";
import { deriveRoleRelationships } from "../../../src/roles/derive.js";
import { renderGeneratedBanner } from "../../_shared/generated-banner.mjs";
import { projectEntityLookup } from "../../_shared/entity-naming.mjs";
import { loadJunctionDefinitions } from "../../_shared/junction-fan-out.mjs";
import {
  loadRuntimeMode,
  runtimeImportLocals,
} from "../../../src/config/runtime-mode.mjs";

// Behavior Registry (inline to avoid import issues with Hygen)
// ============================================================================

const behaviorRegistry = {
  timestamps: {
    name: "timestamps",
    fields: [
      {
        name: "created_at",
        camelName: "createdAt",
        type: "datetime",
        tsType: "Date",
        drizzleType: "timestamp",
        zodType: "z.coerce.date()",
        nullable: false,
      },
      {
        name: "updated_at",
        camelName: "updatedAt",
        type: "datetime",
        tsType: "Date",
        drizzleType: "timestamp",
        zodType: "z.coerce.date()",
        nullable: false,
      },
    ],
    drizzleImports: ["timestamp"],
    configKey: "timestamps",
  },
  soft_delete: {
    name: "soft_delete",
    fields: [
      {
        name: "deleted_at",
        camelName: "deletedAt",
        type: "datetime",
        tsType: "Date | null",
        drizzleType: "timestamp",
        zodType: "z.coerce.date().nullable()",
        nullable: true,
      },
    ],
    drizzleImports: ["timestamp"],
    configKey: "softDelete",
  },
  user_tracking: {
    name: "user_tracking",
    fields: [
      {
        name: "created_by",
        camelName: "createdBy",
        type: "uuid",
        tsType: "string | null",
        drizzleType: "uuid",
        zodType: "z.string().uuid().nullable()",
        nullable: true,
        foreignKey: "users.id",
      },
      {
        name: "updated_by",
        camelName: "updatedBy",
        type: "uuid",
        tsType: "string | null",
        drizzleType: "uuid",
        zodType: "z.string().uuid().nullable()",
        nullable: true,
        foreignKey: "users.id",
      },
    ],
    drizzleImports: ["uuid"],
    configKey: "userTracking",
  },
  temporal_validity: {
    name: "temporal_validity",
    fields: [
      {
        name: "valid_from",
        camelName: "validFrom",
        type: "datetime",
        tsType: "Date | null",
        drizzleType: "timestamp",
        zodType: "z.coerce.date().nullable()",
        nullable: true,
      },
      {
        name: "valid_to",
        camelName: "validTo",
        type: "datetime",
        tsType: "Date | null",
        drizzleType: "timestamp",
        zodType: "z.coerce.date().nullable()",
        nullable: true,
      },
      {
        name: "is_active",
        camelName: "isActive",
        type: "boolean",
        tsType: "boolean",
        drizzleType: "boolean",
        zodType: "z.boolean()",
        nullable: false,
        default: true,
      },
    ],
    drizzleImports: ["timestamp", "boolean"],
    configKey: "temporalValidity",
  },
};

/**
 * Normalize behavior config (string or object with name/options)
 */
/**
 * The set of Drizzle table names codegen OWNS — i.e. that some entity YAML in
 * the project's entities directory generates.
 *
 * Used to decide whether a field-level `foreign_key: <table>.<column>` gets a
 * DB-level `.references()` + a cross-module import, or is emitted as a plain
 * column (#636). A host application owns tables codegen never sees — a tenants
 * table, a users table from an auth provider — and a YAML that references one
 * is legitimate, not an error: the reference is real, it simply is not
 * codegen's to enforce or to import from. Emitting
 * `import { tenants } from '../tenants/tenant.entity'` for such a table
 * produces a module that cannot resolve.
 *
 * Read straight from the YAML `entity.table` (falling back to `entity.plural`,
 * then the pluralized name), never from generated output: a two-pass run must
 * give the same answer on both passes, and introspecting emitted files would
 * make pass 1 disagree with pass 2 (charter I1).
 *
 * Cached per process — `entity new` runs one entity per process, but the
 * cross-entity emitters call in repeatedly.
 */
const __ownedTablesCache = new Map();
export function loadOwnedTableNames(cwd, entitiesDir = BASE_PATHS.entitiesDir) {
  const dir = path.resolve(cwd, entitiesDir);
  const cached = __ownedTablesCache.get(dir);
  if (cached) return cached;
  const owned = new Set();
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // no entities dir in this project — nothing is owned
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.ya?ml$/i.test(e.name)) continue;
      let parsed;
      try {
        parsed = yaml.parse(fs.readFileSync(full, "utf-8"));
      } catch {
        continue; // a malformed YAML is reported by the validator, not here
      }
      const ent = parsed?.entity;
      if (!ent?.name) continue;
      owned.add(ent.table || ent.plural || pluralizePkg.plural(ent.name));
    }
  };
  walk(dir);
  __ownedTablesCache.set(dir, owned);
  return owned;
}

function normalizeBehaviorConfig(config) {
  if (typeof config === "string") {
    return { name: config, options: {} };
  }
  return { name: config.name, options: config.options || {} };
}

/**
 * Resolve behaviors from entity YAML
 */
function resolveBehaviors(behaviorConfigs) {
  const configs = (behaviorConfigs || []).map(normalizeBehaviorConfig);
  const fields = [];
  const drizzleImports = new Set();
  const addedFieldNames = new Set();

  const enabledNames = new Set(configs.map((c) => c.name));

  for (const config of configs) {
    const behavior = behaviorRegistry[config.name];
    if (!behavior) continue;

    for (const field of behavior.fields) {
      if (!addedFieldNames.has(field.name)) {
        fields.push(field);
        addedFieldNames.add(field.name);
      }
    }

    for (const imp of behavior.drizzleImports) {
      drizzleImports.add(imp);
    }
  }

  const hasTimestamps = enabledNames.has("timestamps");
  const hasSoftDelete = enabledNames.has("soft_delete");
  const hasUserTracking = enabledNames.has("user_tracking");
  const hasTemporalValidity = enabledNames.has("temporal_validity");

  return {
    configs,
    fields,
    drizzleImports: Array.from(drizzleImports).sort(),
    repositoryConfig: {
      timestamps: hasTimestamps,
      softDelete: hasSoftDelete,
      userTracking: hasUserTracking,
      temporalValidity: hasTemporalValidity,
      versionable: false,
    },
    hasBehaviors: configs.length > 0,
    hasTimestamps,
    hasSoftDelete,
    hasUserTracking,
    hasTemporalValidity,
  };
}


// ============================================================================
// Patterns — subprocess-local registry load (PATTERN-5)
// ============================================================================
//
// The Hygen subprocess has no shared memory with the CLI process, so the
// pattern registry is rebuilt here from scratch. Library patterns register
// themselves as a side effect of importing the barrel; app-defined patterns
// are loaded from `codegen.config.yaml patterns:` globs (default
// `<backend_src>/patterns/*.pattern.ts`). Both loads are deterministic and
// side-effect-free — the registry determinism test in
// `src/__tests__/patterns/registry.test.ts` pins down that the CLI and the
// subprocess produce identical sorted results for the same file set.

let _patternsLoadPromise = null;

async function ensurePatternsRegistryLoaded() {
  if (!_patternsLoadPromise) {
    _patternsLoadPromise = (async () => {
      // Side-effect import: pre-registers the five library patterns.
      await import('../../../src/patterns/library/index.js');
      const { loadAppPatterns } = await import('../../../src/patterns/registry.js');

      // The resolved `patterns:` manifest (CFG-0); the schema fills an absent
      // key from `paths.backend_src` (PATH-1) — the CLI's `resolvePatternGlobs`.
      const result = await loadAppPatterns(getProjectConfig().patterns, process.cwd());
      for (const err of result.errors) {
        // eslint-disable-next-line no-console
        console.warn(`[codegen] ${err.message}`);
      }
    })();
  }
  return _patternsLoadPromise;
}

export default {
  prompt: async ({ args }) => {
    const yamlPath = args.yaml;
    if (!yamlPath) {
      throw new Error(
        "Missing --yaml argument. Usage: bunx hygen entity new --yaml entities/opportunity.yaml",
      );
    }

    // Load and parse YAML
    const fullPath = path.resolve(process.cwd(), yamlPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const definition = yaml.parse(content);

    // CAP-2 (ADR-041): a `cardinality: one` role IS a `belongs_to`, so it is
    // merged into `definition.relationships` HERE — once, at the single point
    // the YAML enters the template pipeline — and rides the existing FK / index
    // / on-delete path from then on. Every reader downstream (the backend
    // extension) sees the merged form without knowing roles exist. The
    // derivation is shared with the analyzer parser (`src/roles/derive.ts`)
    // because this file parses YAML directly and never sees
    // `EntityDefinitionSchema`: writing the rules in either place alone would
    // make the other a second implementation (I1).
    //
    // A role key can never silently overwrite a declared relationship: the
    // schema rejects that collision at load, and `entity new` validates every
    // file against the schema before hygen runs.
    if (definition && definition.roles) {
      definition.relationships = {
        ...(definition.relationships || {}),
        ...deriveRoleRelationships(definition.roles),
      };
    }

    // Resolve the runtime mode (ADR-037) once — drives every runtime import
    // specifier the generated entity code carries.
    const runtimeMode = loadRuntimeMode(process.cwd());

    const entity = definition.entity;
    const name = entity.name;

    // EVT-7: emits is semantically 3-valued — undefined (fallback path),
    // [] (explicit opt-out), or string[] (typed emission). Preserve the
    // undefined/null-vs-empty distinction by refusing the || null shortcut.
    const emitsBlock = Array.isArray(definition.emits)
      ? definition.emits
      : null;

    const camelCase = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const camelName = camelCase(name);

    // ========================================================================
    // backend template locals
    //
    // backend is the only backend pipeline (ARCH-0, #677). Every body
    // references its locals unguarded, so a missing one throws (#638).
    // ========================================================================

    // Load app-defined patterns (if any) into the registry before the
    // backend extension reads it. `loadAppPatterns` is idempotent
    // and deterministic — calling it every run is cheap (one dynamic
    // import per pattern file) and matches the two-process load story
    // the registry tests pin down.
    await ensurePatternsRegistryLoaded();
    const { buildBackendLocals } = await import('./backend/entity-locals.js');
    // Every cross-entity fact — a belongs_to / has_many / field foreign_key
    // target's table and module folder, an EAV definition entity, a group
    // Actor's members (NAME-0, ADR-041.1) — is read from that entity's own
    // YAML, lazily, on the first reference that needs one. The junctions naming
    // this entity are read from the junction YAMLs.
    // #636 — the Drizzle tables codegen OWNS. The backend extension needs this to
    // tell a host-owned FK target (plain column, no import) from one it generates.
    // ARCH-1 (#682) replaced a `...locals` spread at this call with an explicit key
    // list and did not carry this one, which silently reverted #636:
    // `processFieldFeatures` reads an absent set as "every target is owned", so a
    // host-owned `foreign_key:` became a hard error instead of a plain column.
    // Computed once here and reused in the returned locals below;
    // `loadOwnedTableNames` caches per directory, so the second read is free.
    const ownedTableNames = Array.from(loadOwnedTableNames(process.cwd()));

    const backendLocals = buildBackendLocals(definition, {
      // The backend module tree (PATH-1, #645).
      modulesDir: BASE_PATHS.modulesDir,
      runtimeMode,
      ownedTableNames,
      // REL-2 (#587): the extension computes the relation-manifest and
      // api-includes specifiers RELATIVE to each module folder, so it needs the
      // same generated dir the emitters write into. Passed explicitly because
      // this call takes a key list, not `...locals` — a key omitted here does
      // not fail loudly, it falls back to the default `src/generated` and emits
      // an import that resolves nowhere (see CLAUDE.md, spread-to-explicit-list).
      generatedDir: getGeneratedDir(),
      entityLookup: projectEntityLookup(process.cwd()),
      // JUNC-0 (#678): the junction set this entity's fan-out renders from.
      junctions: loadJunctionDefinitions(process.cwd()),
    });

    // ========================================================================
    // Detection (ADR-033.1 / ADR-033.2 typed provider artifacts)
    // ========================================================================

    // Provider key order is YAML insertion order (preserved by yaml.parse).
    const detectionBlock = (definition.detection && typeof definition.detection === 'object')
      ? definition.detection
      : null;
    const hasDetection = detectionBlock != null && Object.keys(detectionBlock).length > 0;

    // Render the per-entity DetectionConfigs map as a TS object literal.
    // JSON.stringify produces valid TS for the canonical DetectionConfig shape
    // (strings, numbers, booleans, arrays, plain objects). Provider keys keep
    // YAML insertion order. Used by integration-source.ejs.t.
    const detectionConfigsLiteral = hasDetection
      ? JSON.stringify(detectionBlock, null, 2)
      : '{}';

    // ========================================================================
    // EVT-7: emits — resolve typed events for create/update/delete use-cases.
    // ========================================================================
    //
    // The `emits:` list is guaranteed-valid at this point — the CLI pre-flight
    // (`validateEntityEmits`) has already run. Our job is to derive:
    //   • `emitsEvents[]` — one entry per emitted type with payload + mapping.
    //   • `createEventType` / `updateEventType` / `deleteEventType` — the specific
    //     `<entity>_<op>` entries for the three standard CRUD use-cases.
    //   • Payload mapping rules 1..5 (see plan §Payload mapping).
    //
    // We re-merge `events/*.yaml` + entity desugar here because we cannot
    // import the TS generator helpers into a Hygen prompt. The merge is cheap
    // and has no side effects; the validator has already proven correctness.

    const hasEmits = Array.isArray(emitsBlock) && emitsBlock.length > 0;

    const FIELD_TYPE_TO_TS = {
      uuid: 'string',
      string: 'string',
      number: 'number',
      boolean: 'boolean',
      date: 'Date',
      json: 'Record<string, unknown>',
    };

    // Load top-level events/<name>.yaml, tolerant of missing dir / bad files.
    const loadTopLevelEventYamls = (eventsDir) => {
      if (!fs.existsSync(eventsDir)) return new Map();
      const byType = new Map();
      for (const file of fs.readdirSync(eventsDir)) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
        try {
          const content = fs.readFileSync(path.join(eventsDir, file), 'utf-8');
          const parsed = yaml.parse(content);
          if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
            byType.set(parsed.type, parsed);
          }
        } catch {
          // Silently skip — the main event-codegen-generator surfaces parse errors.
        }
      }
      return byType;
    };

    // Desugar entity events: block into top-level-event shape with
    // `{ type, direction: 'change', aggregate, payload: { <key>: { type, nullable } } }`.
    const desugarEntityEventsInline = (entityDefinition) => {
      const out = new Map();
      const entityName = entityDefinition?.entity?.name;
      const evs = entityDefinition?.events ?? [];
      for (const ev of evs) {
        const payload = {};
        for (const [key, t] of Object.entries(ev.body ?? {})) {
          payload[key] = { type: t, nullable: false };
        }
        out.set(ev.name, {
          type: ev.name,
          direction: 'change',
          aggregate: entityName,
          payload,
        });
      }
      return out;
    };

    /**
     * Resolve each emit name into the per-op event descriptor the templates need.
     */
    const resolveEmitsEvents = () => {
      if (!hasEmits) return [];

      // `paths.events_dir` — the directory the CLI's event codegen reads (PATH-0).
      const eventsDir = path.resolve(process.cwd(), getProjectConfig().paths.events_dir);
      const topLevel = loadTopLevelEventYamls(eventsDir);
      const sugar = desugarEntityEventsInline(definition);
      // Top-level wins on collision (same policy as event-codegen-generator).
      const merged = new Map(sugar);
      for (const [k, v] of topLevel) merged.set(k, v);

      // Payload-mapping rules 3/4 read the backend field set — the same
      // list the entity and its DTOs are emitted from, so "is this key on the
      // entity / on CreateXDto" is answered by the emission itself rather than
      // by a second field pass (I1). ARCH-1 (#682): prompt.js's own field
      // processing existed for the deleted `clean` templates and is gone.
      // `processedFields` / `createDtoFields` are the NON-FK fields; the
      // belongs_to FK columns are emitted onto both the entity and CreateXDto
      // from `belongsToFkFields`, so both sets include them.
      const fkKeysCamel = backendLocals.belongsToFkFields.map((f) => f.camelName);
      const entityKeysCamel = new Set([
        ...backendLocals.processedFields.map((f) => f.camelName),
        ...fkKeysCamel,
      ]);
      const dtoKeysCamel = new Set([
        ...backendLocals.createDtoFields.map((f) => f.camelName),
        ...fkKeysCamel,
      ]);

      return emitsBlock.map((emitName) => {
        const ev = merged.get(emitName);
        // `validateEntityEmits` has already guaranteed `ev` is defined. If
        // somehow we get here with an unknown name (e.g. validator bypassed),
        // emit a TODO-only mapping so the generated file still parses.
        const payload = ev?.payload ?? {};
        const payloadKeys = Object.keys(payload).sort();

        const payloadMap = payloadKeys.map((snakeKey) => {
          const field = payload[snakeKey];
          const tsType = FIELD_TYPE_TO_TS[field.type] ?? 'unknown';
          const tsTypeFinal = field.nullable ? `${tsType} | null` : tsType;
          const camelKey = camelCase(snakeKey);

          let expression;
          let todo;

          // Rule 1: <entity>_id or <entityName>Id → entity.id
          if (
            snakeKey === `${name}_id` ||
            camelKey === `${camelName}Id`
          ) {
            expression = 'entity.id';
          }
          // Rule 2: created_by / updated_by → dto.createdBy / dto.updatedBy if present.
          else if (snakeKey === 'created_by' || snakeKey === 'updated_by') {
            const dtoKey = camelKey;
            if (dtoKeysCamel.has(dtoKey)) {
              expression = `dto.${dtoKey}`;
            } else {
              expression = `null as unknown as ${tsTypeFinal}`;
              todo = `supply ${snakeKey} (not on DTO — wire from auth context)`;
            }
          }
          // Rule 3: field present on just-created entity → entity.<camelKey>
          else if (entityKeysCamel.has(camelKey)) {
            expression = `entity.${camelKey}`;
          }
          // Rule 4: field present on input DTO (fallback) → dto.<camelKey>
          else if (dtoKeysCamel.has(camelKey)) {
            expression = `dto.${camelKey}`;
          }
          // Rule 5: otherwise — null placeholder + TODO.
          else {
            expression = `null as unknown as ${tsTypeFinal}`;
            todo = `supply ${snakeKey}`;
          }

          return {
            snakeKey,
            camelKey,
            tsType: tsTypeFinal,
            expression,
            todo,
          };
        });

        return {
          type: emitName,
          aggregate: ev?.aggregate ?? name,
          payloadMap,
        };
      });
    };

    const emitsEvents = resolveEmitsEvents();
    const createEventType =
      emitsEvents.find((e) => e.type === `${name}_created`) ?? null;
    const updateEventType =
      emitsEvents.find((e) => e.type === `${name}_updated`) ?? null;
    const deleteEventType =
      emitsEvents.find((e) => e.type === `${name}_deleted`) ?? null;

    // Mode-resolved runtime import specifiers (ADR-037), one table shared with
    // the unit tests that render backend bodies (`runtimeImportLocals`).
    const runtimeImportSpecifiers = runtimeImportLocals(runtimeMode);

    // @generated banner — single line stamped at the top of every
    // force-overwritten output. `yamlPath` is the consumer-relative source
    // (e.g. `entities/opportunity.yaml`). The extension seam is a pattern or
    // the YAML itself.
    const generatedBanner = renderGeneratedBanner({
      // Relative to cwd so the banner is portable across machines (an absolute
      // path would bake a developer's checkout root into every output).
      source: path.relative(process.cwd(), fullPath),
      generator: 'entity',
      seam: 'a pattern (src/patterns/*.pattern.ts) or the entity YAML',
    });

    return {
      // #636 — the Drizzle tables codegen OWNS. A field-level `foreign_key:`
      // to a table outside this set is host-owned: a plain column, no
      // `.references()` and no import. See loadOwnedTableNames().
      ownedTableNames,
      // @generated DO-NOT-EDIT banner (see renderGeneratedBanner)
      generatedBanner,

      // Runtime mode (ADR-037) — drives runtime import specifiers; read by the
      // backend prompt-extension to rewrite base-class imports.
      runtimeMode,

      // Project layout — the backend prompt-extension places every
      // module under the configured module tree (paths.modules_dir, PATH-1).
      modulesDir: BASE_PATHS.modulesDir,

      // REL-2 (#587): where the whole-set emitters put the relation manifest and
      // the HTTP include allowlist. The generated repository and controller
      // import them by a path relative to their own module folder, computed in
      // the backend prompt-extension.
      generatedDir: getGeneratedDir(),

      // Detection (ADR-033.1 / ADR-033.2 typed provider artifacts)
      hasDetection,
      detectionConfigsLiteral,

      // EVT-7: emits (typed auto-emission via TypedEventBus)
      hasEmits,
      createEventType,
      updateEventType,
      deleteEventType,

      ...runtimeImportSpecifiers,
      ...backendLocals,
    };
  },
};
