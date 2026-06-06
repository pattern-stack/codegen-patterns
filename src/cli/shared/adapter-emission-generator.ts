/**
 * Adapter / module / barrel / surface-aggregator emission (RFC-0001 §2 + §4,
 * Track D · D3).
 *
 * Per (provider × surface) — driven by `definitions/providers/*.yaml`
 * `surfaces[]` ∩ the surfaces a `<Surface>Port` package exists for — emits the
 * layer that ties D2's provider modules, C6's `<Surface>Port`, and C7's
 * `IEntityChangeSourceRegistry` together:
 *
 *   src/integrations/<surface>/
 *     adapters/
 *       <provider>/<provider>-<surface>.adapter.ts          SCAFFOLD (emit-once)
 *       <provider>/<provider>-<surface>.adapter.module.ts   @generated (re-emit)
 *       index.ts                                            @generated barrel
 *     <surface>-adapters.tokens.ts                          @generated (minimal — D4 owns full)
 *     <surface>-adapters.module.ts                          @generated aggregator
 *
 * **Surface → port mapping.** A scaffold `implements <Surface>Port`, so a
 * surface is only emittable once its surface package exists (Track C). Today
 * only `crm` (CrmPort, C6) does; a provider serving `calendar`/`mail`/etc. is
 * recorded in `skippedSurfaces` with a clear reason until that surface's
 * package lands. This is the deliberate seam, not an omission.
 *
 * **Emit-once.** The adapter scaffold carries a `// <CODEGEN-SCAFFOLD-V1>`
 * sentinel; on re-emit an existing scaffold is detected and skipped
 * (author-owned). Everything else is fully codegen-owned and re-emitted
 * byte-identically (RFC-0001 §2 idempotency).
 *
 * **D4 boundary.** The registry tokens' full contract (multi-injection
 * semantics, the AdapterContribution fold, per-consumer typed views, removal of
 * ADR-033.2 tuples) is Track D · D4. D3 emits a *minimal* tokens file so the
 * modules compile and notes D4 owns the finalized contract — it does not pull
 * D4 forward.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type ActiveProviderDefinition, isActiveProvider, parseImportRef, type ProviderDefinition } from "../../schema/provider-definition.schema";
import type { LoadedProvider } from "../../parser/validate-providers";
import { isDivisibleCursor } from "../../../runtime/subsystems/integration";
import type {
  DetectionConfig,
  ResolvedFilter,
} from "../../../runtime/subsystems/integration";
import { providerConstantCase, providerPascalCase } from "./provider-module-generator";
import { generateDefaultSink, type SinkEmitInput } from "./sink-emission-generator";
import {
  generateAssemblyModule,
  generateIntegrationAggregator,
  generateIntegrationTokens,
  resolveEntityModuleImports,
  type IntegrationAssemblyEntry,
  type IntegrationTokenEntry,
} from "./assembly-emission-generator";
import { subsystemsImport, type RuntimeMode } from "./runtime-import";
import pluralize from "pluralize";

// ============================================================================
// Surface registry — which surfaces have an emittable <Surface>Port package
// ============================================================================

interface L2PortSpec {
  /** Property name on the port (`fields`). */
  prop: string;
  /** Port interface type (`IFieldDefinitionReader`). */
  type: string;
  /** Stub method name (`list`). */
  method: string;
  /** Stub method parameter list, args underscore-prefixed (`(_integrationId, _entity)`). */
  params: string;
  /** Matching `CrmCapabilities` flag (`fieldDefinitions`). */
  capFlag: string;
}

interface SurfaceSpec {
  /** Package the port + vocab come from. */
  packageName: string;
  /** Composing port type (`CrmPort`). */
  portType: string;
  /** Capabilities type (`CrmCapabilities`). */
  capabilitiesType: string;
  /** Empty-capabilities const (`NO_CRM_CAPABILITIES`). */
  noCapsConst: string;
  /** L2 ports the adapter implements (stubbed). */
  l2Ports: L2PortSpec[];
  /**
   * Interaction surfaces (mail/calendar/transcript) whose reads go through the
   * `IncrementalRead` enumerate/hydrate primitive (RFC-0003). When `true`, the
   * scaffold emits a per-entity `IncrementalReadBase<Canonical<Entity>,
   * ResolvedFilter[]>` subclass and registers it in `changeSources`. When falsy
   * (e.g. `crm` — field-reader model, no single canonical `T`), the scaffold
   * keeps the empty author-filled `changeSources` seam.
   */
  readPrimitive?: boolean;
}

/**
 * Known surfaces. Extend as Track C ships more surface packages (mail,
 * calendar, transcript, …). A provider surface absent here is skipped.
 */
export const SURFACE_REGISTRY: Record<string, SurfaceSpec> = {
  crm: {
    packageName: "@pattern-stack/codegen-crm",
    portType: "CrmPort",
    capabilitiesType: "CrmCapabilities",
    noCapsConst: "NO_CRM_CAPABILITIES",
    l2Ports: [
      {
        prop: "fields",
        type: "IFieldDefinitionReader",
        method: "list",
        params: "(_integrationId, _entity)",
        capFlag: "fieldDefinitions",
      },
      {
        prop: "picklists",
        type: "IPicklistReader",
        method: "values",
        params: "(_integrationId, _entity, _fieldId)",
        capFlag: "picklists",
      },
      {
        prop: "associations",
        type: "IAssociationReader",
        method: "list",
        params: "(_integrationId, _fromEntity, _fromId, _toEntity)",
        capFlag: "associations",
      },
    ],
  },
  // Interaction surfaces (#416) are incremental-read with no L2 sub-ports — the
  // port composes L1 (auth + sources) + a capabilities descriptor whose only
  // field is `entities`; reads go through the change-source registry. So
  // `l2Ports: []` and the scaffold emits no L2 readers/stubs/capability flags.
  calendar: {
    packageName: "@pattern-stack/codegen-calendar",
    portType: "CalendarPort",
    capabilitiesType: "CalendarCapabilities",
    noCapsConst: "NO_CALENDAR_CAPABILITIES",
    l2Ports: [],
    readPrimitive: true,
  },
  mail: {
    packageName: "@pattern-stack/codegen-mail",
    portType: "MailPort",
    capabilitiesType: "MailCapabilities",
    noCapsConst: "NO_MAIL_CAPABILITIES",
    l2Ports: [],
    readPrimitive: true,
  },
  transcript: {
    packageName: "@pattern-stack/codegen-transcript",
    portType: "TranscriptPort",
    capabilitiesType: "TranscriptCapabilities",
    noCapsConst: "NO_TRANSCRIPT_CAPABILITIES",
    l2Ports: [],
    readPrimitive: true,
  },
  // messaging (swe-brain ADR-0008) — interaction surface like transcript: the
  // adapter contributes per-entity change sources for `channel` + `message`
  // (`conversation` is domain-derived by segmentation, not vendor-read). The
  // capability descriptor adds an optional `canWrite` flag for the bot-user write
  // path, which ships dark in v1; the scaffold still only constructs `entities`.
  messaging: {
    packageName: "@pattern-stack/codegen-messaging",
    portType: "MessagingPort",
    capabilitiesType: "MessagingCapabilities",
    noCapsConst: "NO_MESSAGING_CAPABILITIES",
    l2Ports: [],
    readPrimitive: true,
  },
};

/**
 * A provider is "client-less" (per-connection auth, RFC-0003 R5) when EVERY
 * surface it serves is a read-primitive interaction surface — calendar/mail/
 * transcript/messaging. Such providers build a per-connection client inside
 * `enumerate`/`hydrate` from `ctx.subscription.externalRef`, so the provider
 * module drops the singleton `<SLUG>_CLIENT` and registry-backs the strategy.
 *
 * A provider with ANY non-read-primitive surface (e.g. `crm`, single-account
 * provider-level auth) keeps the client-ful shape: only drop the client when no
 * surface needs a singleton client. A surface unknown to `SURFACE_REGISTRY` is
 * treated as needing a client (conservative — keeps the legacy shape).
 */
export function isClientlessProvider(surfaces: readonly string[]): boolean {
  return (
    surfaces.length > 0 &&
    surfaces.every((s) => SURFACE_REGISTRY[s]?.readPrimitive === true)
  );
}

// ============================================================================
// Banner + sentinel
// ============================================================================

const SCAFFOLD_SENTINEL = "// <CODEGEN-SCAFFOLD-V1>";

function generatedBanner(sourceDesc: string): string {
  return (
    `// @generated by @pattern-stack/codegen from ${sourceDesc} — DO NOT EDIT.\n` +
    `// Hand edits are overwritten on re-emit. Regenerate with \`bun run codegen\`.`
  );
}

// ============================================================================
// Entities-by-surface
// ============================================================================

/**
 * Group entity names by their declared `surface:` (the field added in D1). The
 * union per surface populates each adapter's `capabilities.entities`.
 */
export function collectEntitiesBySurface(
  entities: Iterable<{ entity: { name: string; surface?: string } }>,
): Map<string, string[]> {
  const bySurface = new Map<string, string[]>();
  for (const e of entities) {
    const surface = e.entity.surface;
    if (!surface) continue;
    const list = bySurface.get(surface) ?? [];
    list.push(e.entity.name);
    bySurface.set(surface, list);
  }
  // Deterministic order within each surface.
  for (const [surface, list] of bySurface) {
    bySurface.set(surface, [...list].sort());
  }
  return bySurface;
}

// ============================================================================
// Naming
// ============================================================================

interface Names {
  providerPascal: string; // Hubspot
  providerConst: string; // HUBSPOT
  surfacePascal: string; // Crm
  surfaceConst: string; // CRM
  adapterClass: string; // HubspotCrmAdapter
  adapterModuleClass: string; // HubspotCrmAdapterModule
  providerModuleClass: string; // HubspotProviderModule
  aggregatorClass: string; // CrmAdaptersModule
  strategyToken: string; // HUBSPOT_AUTH_STRATEGY
  clientToken: string; // HUBSPOT_CLIENT
  contributionsToken: string; // CRM_ADAPTER_CONTRIBUTIONS
  entitySourcesToken: string; // CRM_ENTITY_SOURCES
}

function names(providerSlug: string, surface: string): Names {
  const providerPascal = providerPascalCase(providerSlug);
  const providerConst = providerConstantCase(providerSlug);
  const surfacePascal = providerPascalCase(surface);
  const surfaceConst = providerConstantCase(surface);
  return {
    providerPascal,
    providerConst,
    surfacePascal,
    surfaceConst,
    adapterClass: `${providerPascal}${surfacePascal}Adapter`,
    adapterModuleClass: `${providerPascal}${surfacePascal}AdapterModule`,
    providerModuleClass: `${providerPascal}ProviderModule`,
    aggregatorClass: `${surfacePascal}AdaptersModule`,
    strategyToken: `${providerConst}_AUTH_STRATEGY`,
    clientToken: `${providerConst}_CLIENT`,
    contributionsToken: `${surfaceConst}_ADAPTER_CONTRIBUTIONS`,
    entitySourcesToken: `${surfaceConst}_ENTITY_SOURCES`,
  };
}

// ============================================================================
// Pure emitters
// ============================================================================

/** PascalCase an entity name, splitting on `-`/`_` (`calendar_event` → `CalendarEvent`). */
function entityPascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/** CONSTANT_CASE an entity name (`calendar-event` → `CALENDAR_EVENT`). */
function entityConstCase(name: string): string {
  return name.replace(/-/g, "_").toUpperCase();
}

/** Emit a `ResolvedFilter[]` TS literal (one line per clause, or `[]`). */
function serializeFilterArray(filters: ResolvedFilter[]): string {
  if (filters.length === 0) return "[]";
  const items = filters.map(
    (f) =>
      `  { field: ${JSON.stringify(f.field)}, op: ${JSON.stringify(f.op)}, value: ${JSON.stringify(f.value)} },`,
  );
  return `[\n${items.join("\n")}\n]`;
}

interface ReadPrimitiveEmission {
  /** Canonical record types to import from the surface package. */
  canonicalTypes: string[];
  /** Module-level filter consts + `IncrementalReadBase` subclasses. */
  preamble: string;
  /** `changeSources` object-literal entries (one per entity). */
  changeSourceEntries: string[];
}

/**
 * Build the read-side emission for an interaction surface (RFC-0003 R3): one
 * `IncrementalReadBase<Canonical<Entity>, ResolvedFilter[]>` subclass per entity
 * (fork #1 typing), a static `detection.filters` const returned by `filterFor`
 * (fork #2 threading), and `cursorDivisible = false` when the entity's cursor
 * strategy is atomic (R2 wiring). The author fills `enumerate`/`hydrate`/
 * `toCanonical`. The subclass ctor injects auth only (RFC-0003 R5): there is no
 * provider-level singleton client — per-connection adapters build a client
 * inside `enumerate`/`hydrate` from `ctx.subscription.externalRef` via
 * `auth.resolve(...)`.
 */
function buildReadPrimitiveEmission(
  providerSlug: string,
  providerPascal: string,
  surface: string,
  entities: string[],
  entityDetection: Map<string, DetectionConfig> | undefined,
): ReadPrimitiveEmission {
  const canonicalTypes: string[] = [];
  const blocks: string[] = [];
  const entries: string[] = [];

  for (const entity of entities) {
    const pascal = entityPascalCase(entity);
    const canonical = `Canonical${pascal}`;
    const className = `${providerPascal}${pascal}IncrementalRead`;
    const constName = `${entityConstCase(entity)}_DETECTION_FILTERS`;
    canonicalTypes.push(canonical);

    const det = entityDetection?.get(entity);
    const filters = det?.filters ?? [];
    const cursorKind = det && det.mode === "poll" ? det.poll.cursor.kind : undefined;
    const atomic = cursorKind !== undefined && !isDivisibleCursor(cursorKind);
    const cursorOverride = atomic
      ? `
  // \`${cursorKind}\` is an ATOMIC cursor (RFC-0003 §3): its next value only exists
  // at end-of-walk, so per-ref cursors are withheld and only the final record
  // carries the token — a mid-walk crash never persists an unresumable value.
  protected override readonly cursorDivisible = false;`
      : "";

    blocks.push(`/**
 * \`detection.filters\` for \`${entity}\`, emitted from YAML as a static
 * \`ResolvedFilter[]\` (RFC-0003 §4 fork #2); \`filterFor()\` returns it.
 */
const ${constName}: ResolvedFilter[] = ${serializeFilterArray(filters)};

// Emit-once read primitive (author-owned). Fill the three vendor methods below.
export class ${className} extends IncrementalReadBase<${canonical}, ResolvedFilter[]> {
  readonly label = '${providerSlug}-${surface}-${entity}';
  // Flip to \`true\` if your \`enumerate\` pushes the request filter to the vendor
  // (e.g. Gmail \`q=\`); leave \`false\` to filter post-hydrate via \`matchesRecord\`.
  protected override readonly filterPushdown = false;${cursorOverride}

  constructor(private readonly auth: IAuthStrategy) {
    super();
  }

  /**
   * TODO: walk the vendor list endpoint → pages of \`Ref\` (id + cursor + meta).
   * Per-connection (multi-account) adapters resolve credentials here from the
   * threaded subscription, e.g.
   * \`const client = <vendorClientFactory>({ accessToken: async () => (await this.auth.resolve(_ctx!.subscription!.externalRef)).accessToken });\`
   * — there is no provider-level singleton client. Provider-level-auth adapters
   * ignore \`_ctx\`.
   */
  protected async *enumerate(
    _mode: ReadMode,
    _filter?: ResolvedFilter[],
    _pageSize?: number,
    _ctx?: ReadContext,
  ): AsyncIterable<Ref[]> {
    throw new Error('not implemented: ${className}.enumerate');
  }

  /**
   * TODO: batched fetch-by-id → \`Map<id, raw>\` (\`mapConcurrent\`, or a vendor /batch).
   * Use \`_ctx?.subscription?.id\` to key raw-landing rows per connection.
   */
  protected async hydrate(_ids: string[], _ctx?: ReadContext): Promise<Map<string, unknown>> {
    throw new Error('not implemented: ${className}.hydrate');
  }

  /** TODO: vendor payload → \`${canonical}\` (return \`null\` to drop). */
  protected toCanonical(_raw: unknown): ${canonical} | null {
    throw new Error('not implemented: ${className}.toCanonical');
  }

  protected override filterFor(
    _subscription: IntegrationSubscriptionView,
  ): ResolvedFilter[] {
    return ${constName};
  }
}`);
    entries.push(`      ${entity}: new ${className}(this.auth),`);
  }

  return { canonicalTypes, preamble: blocks.join("\n\n"), changeSourceEntries: entries };
}

/**
 * The emit-once adapter scaffold. Implements the surface port, injects L1
 * (auth strategy + client), declares capabilities (entities from `surface:`),
 * and stubs the L2 port methods. For interaction surfaces (`readPrimitive`),
 * emits per-entity `IncrementalReadBase` subclasses + `changeSources`
 * registration (RFC-0003 R3); `entityDetection` supplies each entity's parsed
 * `DetectionConfig` (resolved for this provider) for the filter const + cursor
 * divisibility.
 */
export function generateAdapterScaffold(
  def: ActiveProviderDefinition,
  surface: string,
  entities: string[],
  entityDetection?: Map<string, DetectionConfig>,
  mode: RuntimeMode = "package",
): string {
  const spec = SURFACE_REGISTRY[surface];
  if (!spec) throw new Error(`no surface package for '${surface}'`);
  const n = names(def.slug, surface);
  const client = parseImportRef(def.client.class);
  // RFC-0001/0003 emitter imports the L1 strategies/read-primitive from the
  // runtime; the specifier is mode-resolved (ADR-037). The adapter scaffold
  // pulls from the `integration` subsystem barrel.
  const subsystemsSpec = subsystemsImport(mode, "integration");

  const entitiesLiteral = entities.length
    ? `[${entities.map((e) => `'${e}'`).join(", ")}]`
    : "[]";

  // RFC-0003 R3: interaction surfaces emit per-entity IncrementalReadBase
  // subclasses + changeSources registration; other surfaces keep the empty seam.
  const readPrimitive = !!spec.readPrimitive && entities.length > 0;
  const rp = readPrimitive
    ? buildReadPrimitiveEmission(
        def.slug,
        n.providerPascal,
        surface,
        entities,
        entityDetection,
      )
    : null;

  // Surface-package type imports: the port, each L2 reader type (none for
  // incremental-read interaction surfaces), the capabilities type, then (for
  // read-primitive surfaces) each entity's canonical record type. Sorted to
  // match biome's organize-imports order so the emitted file is canonical.
  const surfaceTypeImports = [
    spec.portType,
    ...spec.l2Ports.map((p) => p.type),
    spec.capabilitiesType,
    ...(rp ? rp.canonicalTypes : []),
  ]
    .sort()
    .map((t) => `  ${t},`)
    .join("\n");

  // Subsystems imports: IncrementalReadBase is a value import (read-primitive
  // only); the rest are types. ReadContext/ReadMode/Ref/ResolvedFilter/
  // IntegrationSubscriptionView are only needed when subclasses are emitted.
  // The list is kept alphabetical to match biome's organize-imports order.
  const subsystemValueImport = rp
    ? `import { IncrementalReadBase } from '${subsystemsSpec}';\n`
    : "";
  const subsystemTypeImports = [
    "IAuthStrategy",
    "IChangeSource",
    ...(rp
      ? [
          "IntegrationSubscriptionView",
          "ReadContext",
          "ReadMode",
          "Ref",
          "ResolvedFilter",
        ]
      : []),
  ]
    .map((t) => `  ${t},`)
    .join("\n");

  // Read-primitive: changeSources is assigned in the constructor BODY (not a
  // field initializer) — under useDefineForClassFields, field initializers run
  // before constructor parameter-property assignment, so `this.auth`/`this.client`
  // would be undefined at field-init time.
  const changeSourcesAssign = rp
    ? `\n    this.changeSources = {\n${rp.changeSourceEntries.join("\n")}\n    };\n  `
    : "";
  const changeSourcesDecl = rp
    ? `  /**
   * Per-entity change sources contributed to the ${surface} registry, keyed by
   * entity name. The surface aggregator folds these into the
   * \`IEntityChangeSourceRegistry\` bound under \`${n.entitySourcesToken}\`.
   * Emit-once: edit the \`IncrementalReadBase\` subclasses above, not this map.
   */
  readonly changeSources: Record<string, IChangeSource<unknown>>;`
    : `  /**
   * Per-entity change sources this adapter contributes to the ${surface}
   * registry (ADR-033 \`buildChangeSource\`), keyed by entity name. The
   * surface aggregator folds these into the \`IEntityChangeSourceRegistry\`
   * bound under \`${n.entitySourcesToken}\`. Author-owned — populate one entry
   * per entity in \`capabilities.entities\`.
   */
  readonly changeSources: Record<string, IChangeSource<unknown>> = {};`;
  const preambleSection = rp ? `\n${rp.preamble}\n` : "";

  // Capabilities literal body: the empty-caps spread, a `true` flag per L2 port
  // (none for interaction surfaces), then the surface-derived entities.
  const capabilityBody = [
    `    ...${spec.noCapsConst},`,
    ...spec.l2Ports.map((p) => `    ${p.capFlag}: true,`),
    `    entities: ${entitiesLiteral},`,
  ].join("\n");

  const l2Members = spec.l2Ports
    .map(
      (p) => `  /** L2 — fill in the provider-specific implementation. */
  readonly ${p.prop}: ${p.type} = {
    ${p.method}: async ${p.params} => {
      throw new Error('not implemented: ${n.adapterClass}.${p.prop}.${p.method}');
    },
  };`,
    )
    .join("\n\n");
  // Only emit the L2 section (with surrounding blank lines) when there are L2
  // ports — interaction surfaces omit it entirely.
  const l2Section = l2Members ? `\n${l2Members}\n` : "";

  // RFC-0003 R5: read-primitive (per-connection) adapters inject AUTH ONLY —
  // there is no provider-level singleton client (the provider module no longer
  // emits `<SLUG>_CLIENT`). The per-connection client is built INSIDE
  // `enumerate`/`hydrate` from `ctx.subscription.externalRef`. CRM (and any
  // non-read-primitive surface) keeps the client injection. Both the client type
  // import and the `<SLUG>_CLIENT` token import are therefore dropped under `rp`.
  const clientTypeImport = rp
    ? ""
    : `import type { ${client.exportName} } from '${client.path}';\n`;
  const providerTokenImport = rp
    ? `import { ${n.strategyToken} } from '../../../providers/${def.slug}/${def.slug}.provider.module';`
    : `import { ${n.strategyToken}, ${n.clientToken} } from '../../../providers/${def.slug}/${def.slug}.provider.module';`;
  const ctorClientParam = rp
    ? ""
    : `\n    @Inject(${n.clientToken}) private readonly client: ${client.exportName},`;
  const ctorOpen = rp
    ? `  constructor(@Inject(${n.strategyToken}) readonly auth: IAuthStrategy) {${changeSourcesAssign}}`
    : `  constructor(
    @Inject(${n.strategyToken}) readonly auth: IAuthStrategy,${ctorClientParam}
  ) {${changeSourcesAssign}}`;

  return `${SCAFFOLD_SENTINEL}
// Scaffolded once by @pattern-stack/codegen, then author-owned. Re-running
// codegen detects the sentinel above and SKIPS this file — your edits are safe.
// Source: definitions/providers/${def.slug}.yaml (surface: ${surface}).
import { Inject, Injectable } from '@nestjs/common';
import type {
${surfaceTypeImports}
} from '${spec.packageName}';
import { ${spec.noCapsConst} } from '${spec.packageName}';
${subsystemValueImport}import type {
${subsystemTypeImports}
} from '${subsystemsSpec}';
${clientTypeImport}${providerTokenImport}
${preambleSection}
@Injectable()
export class ${n.adapterClass} implements ${spec.portType} {
  /** Declared capabilities. \`entities\` derives from \`surface: ${surface}\` entity YAML. */
  readonly capabilities: ${spec.capabilitiesType} = {
${capabilityBody}
  };

${ctorOpen}
${l2Section}
${changeSourcesDecl}

  // surface-only methods (optional on ${spec.portType}): add here
}
`;
}

/**
 * Fully codegen-owned adapter module — provides the adapter and imports its
 * provider module. The adapter is exported so the surface aggregator can inject
 * it and read its `changeSources` for the registry fold (RFC-0001 §3).
 */
export function generateAdapterModule(def: ProviderDefinition, surface: string): string {
  const n = names(def.slug, surface);
  return `${generatedBanner(`definitions/providers/${def.slug}.yaml (surface: ${surface})`)}
import { Module } from '@nestjs/common';
import { ${n.providerModuleClass} } from '../../../providers/${def.slug}/${def.slug}.provider.module';
import { ${n.adapterClass} } from './${def.slug}-${surface}.adapter';

@Module({
  imports: [${n.providerModuleClass}],
  providers: [${n.adapterClass}],
  exports: [${n.adapterClass}],
})
export class ${n.adapterModuleClass} {}
`;
}

/** Auto-generated barrel re-exporting every adapter module for a surface. */
export function generateAdaptersBarrel(
  surface: string,
  providerSlugs: string[],
): string {
  const lines = [...providerSlugs]
    .sort()
    .map((slug) => {
      const n = names(slug, surface);
      return `export { ${n.adapterModuleClass} } from './${slug}/${slug}-${surface}.adapter.module';`;
    })
    .join("\n");
  return `${generatedBanner(`definitions/providers/*.yaml (surface: ${surface})`)}
${lines}
`;
}

/**
 * Per-surface registry tokens + contribution shape (RFC-0001 §3).
 *
 * `<SURFACE>_ADAPTER_CONTRIBUTIONS` is the assembled list of every adapter's
 * contribution (NestJS has no `multi:true`; the surface aggregator — which
 * codegen emits with full knowledge of the surface's adapters — assembles it
 * from the adapters by direct injection). `<SURFACE>_ENTITY_SOURCES` resolves to
 * the folded C7 `IEntityChangeSourceRegistry`.
 */
export function generateSurfaceTokens(
  surface: string,
  mode: RuntimeMode = "package",
): string {
  const n = names("__placeholder__", surface);
  return `${generatedBanner(`surface: ${surface}`)}
import type { IChangeSource } from '${subsystemsImport(mode, "integration")}';

/** The assembled list of every ${surface} adapter's contribution. */
export const ${n.contributionsToken} = Symbol.for('@app/integrations/${surface}.adapter-contributions');

/** Resolved registry token — resolves to a C7 IEntityChangeSourceRegistry. */
export const ${n.entitySourcesToken} = Symbol.for('@app/integrations/${surface}.entity-sources');

/** One provider-adapter's contribution to the surface registry. */
export interface AdapterContribution {
  /** Provider slug. */
  provider: string;
  /** Entities this provider serves on this surface → their change sources. */
  sources: Record<string, IChangeSource<unknown>>;
}
`;
}

/**
 * The thin factory aggregator (RFC-0001 §3). Assembles every adapter's
 * contribution into `<SURFACE>_ADAPTER_CONTRIBUTIONS` and folds them into one
 * `IEntityChangeSourceRegistry` bound under `<SURFACE>_ENTITY_SOURCES`.
 *
 * NestJS has no `multi:true`, so — knowing the full adapter set at emit time —
 * codegen injects each adapter directly and assembles the contributions array
 * here. Two providers serving the same entity is an ambiguous-source boot error
 * (the registry is entity-keyed; one entity resolves to one source).
 */
export function generateSurfaceAggregator(
  surface: string,
  providerSlugs: string[],
  mode: RuntimeMode = "package",
): string {
  const n = names("__placeholder__", surface);
  const slugs = [...providerSlugs].sort();
  const per = slugs.map((slug) => names(slug, surface));
  const moduleClasses = per.map((p) => p.adapterModuleClass);

  const moduleImport = `import {\n  ${moduleClasses.join(",\n  ")},\n} from './adapters';`;
  const adapterImports = slugs
    .map((slug) => {
      const p = names(slug, surface);
      return `import { ${p.adapterClass} } from './adapters/${slug}/${slug}-${surface}.adapter';`;
    })
    .join("\n");

  const contributionEntries = slugs
    .map((slug) => {
      const p = names(slug, surface);
      return `        { provider: '${slug}', sources: ${lowerFirst(p.adapterClass)}.changeSources },`;
    })
    .join("\n");
  const injectParams = slugs
    .map((slug) => {
      const p = names(slug, surface);
      return `${lowerFirst(p.adapterClass)}: ${p.adapterClass}`;
    })
    .join(", ");
  const injectTokens = per.map((p) => p.adapterClass).join(", ");

  return `${generatedBanner(`surface: ${surface}`)}
import { Module } from '@nestjs/common';
import {
  MemoryEntityChangeSourceRegistry,
  type IChangeSource,
  type IEntityChangeSourceRegistry,
} from '${subsystemsImport(mode, "integration")}';
${moduleImport}
${adapterImports}
import {
  ${n.contributionsToken},
  ${n.entitySourcesToken},
  type AdapterContribution,
} from './${surface}-adapters.tokens';

/**
 * Fold every adapter contribution into one entity-keyed registry. Each entity
 * resolves to exactly one change source; two providers serving the same entity
 * is an ambiguous-source boot error.
 */
function provide${n.surfacePascal}EntitySources(
  contribs: AdapterContribution[],
): IEntityChangeSourceRegistry {
  const merged = new Map<string, IChangeSource<unknown>>();
  const owner = new Map<string, string>();
  for (const contrib of contribs ?? []) {
    for (const [entity, source] of Object.entries(contrib.sources)) {
      const prior = owner.get(entity);
      if (prior !== undefined) {
        throw new Error(
          \`entity '\${entity}' is served by both '\${prior}' and '\${contrib.provider}' — ambiguous change source\`,
        );
      }
      owner.set(entity, contrib.provider);
      merged.set(entity, source);
    }
  }
  return new MemoryEntityChangeSourceRegistry(merged);
}

@Module({
  imports: [${moduleClasses.join(", ")}],
  providers: [
    {
      provide: ${n.contributionsToken},
      useFactory: (${injectParams}): AdapterContribution[] => [
${contributionEntries}
      ],
      inject: [${injectTokens}],
    },
    {
      provide: ${n.entitySourcesToken},
      useFactory: (contributions: AdapterContribution[]) =>
        provide${n.surfacePascal}EntitySources(contributions),
      inject: [${n.contributionsToken}],
    },
  ],
  exports: [${n.entitySourcesToken}, ${n.contributionsToken}],
})
export class ${n.aggregatorClass} {}
`;
}

/** `HubspotCrmAdapter` → `hubspotCrmAdapter` (DI factory param name). */
function lowerFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * Per-consumer typed view (RFC-0001 §5) — `types.generated.ts`. Surface-scoped
 * provider/entity unions + a (provider, entity) validity map so consumer
 * use-cases get compile-time errors on bad pairings. The typed replacement for
 * ADR-033.2's per-entity tuples. Fully codegen-owned, re-emitted every run.
 */
export function generateTypedView(
  surface: string,
  providerSlugs: string[],
  entities: string[],
): string {
  const surfacePascal = providerPascalCase(surface);
  const slugs = [...providerSlugs].sort();
  const ents = [...entities].sort();
  const providerUnion = slugs.length
    ? slugs.map((s) => `'${s}'`).join(" | ")
    : "never";
  const entityUnion = ents.length ? ents.map((e) => `'${e}'`).join(" | ") : "never";

  // (provider, entity) validity map: each provider serves this surface, so it
  // may source any of the surface's entities. Per-provider entity granularity
  // (which provider actually serves which entity) is detection-config data and
  // can refine this later.
  const mapEntries = slugs
    .map((s) => `  ${jsKey(s)}: ${surfacePascal}Entity;`)
    .join("\n");

  return `${generatedBanner(`surface: ${surface}`)}
/**
 * Per-consumer typed view for the \`${surface}\` surface. Surface-scoped unions
 * + a (provider, entity) validity map for compile-time-checked consumer
 * use-cases. Replaces ADR-033.2's per-entity provider tuples (RFC-0001 §5/§8).
 */

/** Providers whose \`surfaces[]\` include \`${surface}\`. */
export type ${surfacePascal}Provider = ${providerUnion};

/** Entities declared with \`surface: ${surface}\`. */
export type ${surfacePascal}Entity = ${entityUnion};

/** Valid entities per provider on this surface. */
export interface ${surfacePascal}ProviderEntities {
${mapEntries || "  // no providers serve this surface yet"}
}
`;
}

/** Quote an object key only if it isn't a valid bare identifier (e.g. kebab slugs). */
function jsKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${key}'`;
}

// ============================================================================
// Orchestration
// ============================================================================

/**
 * The slice of a parsed entity definition the adapter + assembly + sink
 * emission needs. The CLI passes the full loaded `entityDefs` (which structurally
 * satisfy this) so no extra projection is required at the call site.
 *
 * - `entity.name` / `entity.surface` drive capabilities.entities (RFC-0001).
 * - `entity.pattern` gates assembly+sink emission (`Integrated` only, RFC-0002 §4).
 * - `entity.plural` / `entity.context` drive the entity repo/module import paths.
 * - `fields` → sink copy-through scalars; `relationships` (belongs_to) → FK keys.
 */
export interface EmitAdaptersEntity {
  entity: {
    name: string;
    surface?: string;
    pattern?: string;
    patterns?: string[];
    plural?: string;
    context?: string;
    /** Provider-keyed detection config (ADR-033). Drives the emitted read
     *  primitive's static filter const + cursor divisibility (RFC-0003 R3). */
    detection?: Record<string, DetectionConfig>;
  };
  fields?: Record<string, { type?: string; nullable?: boolean }>;
  relationships?: Record<
    string,
    { type?: string; target?: string; foreign_key?: string; nullable?: boolean }
  >;
}

export interface EmitAdaptersOptions {
  providers: LoadedProvider[];
  /** Entity definitions carrying `surface:` (for capabilities.entities + the
   *  per-entity assembly/sink emission). */
  entities: EmitAdaptersEntity[];
  /** Output root — `<backend_src>/integrations`. */
  outputRoot: string;
  /** Absolute `<backend_src>` root on disk — needed to resolve the entity
   *  repo/module import specifiers for the assembly. When omitted, the assembly
   *  loop is skipped (back-compat for callers that only want the read side, e.g.
   *  a dry plan with no consumer tree). */
  backendSrcAbs?: string;
  /** tsconfig path aliases (aliasKey → absolute target dir) for the entity
   *  repo/module imports. Empty/absent ⇒ relative-path imports. */
  aliases?: Record<string, string>;
  /** When true, compute the plan but write nothing. */
  dryRun?: boolean;
  /** Runtime mode (ADR-037) — selects the runtime import specifiers in every
   *  emitted adapter/module/tokens/sink/assembly file. Defaults to `package`. */
  mode?: RuntimeMode;
}

export interface EmitAdaptersResult {
  /** @generated files written (modules, barrels, tokens, aggregators, assemblies). */
  written: string[];
  /** New scaffolds written this run (adapter scaffolds + sink scaffolds). */
  scaffoldsWritten: string[];
  /** Existing scaffolds skipped (author-owned). */
  scaffoldsSkipped: string[];
  /** (provider, surface) pairs skipped because the surface has no port package. */
  skippedSurfaces: Array<{ provider: string; surface: string; reason: string }>;
  /** Per-entity assembly modules written this run (RFC-0002 §2, @generated). */
  assembliesWritten: string[];
  /** Surface integration tokens files written this run (RFC-0002 §2, @generated). */
  tokensWritten: string[];
  /** Surface integration aggregator modules written this run — one
   *  `<surface>-integration.module.ts` per surface with ≥1 assembly (RFC-0002
   *  §1, E3, @generated). The AppModule entry point for the surface. */
  integrationAggregatorsWritten: string[];
  /** `surface:` entities skipped for assembly/sink because they are not
   *  `pattern: Integrated` (the only family with the projection/upsert path).
   *  Recorded, not crashed — the read side still emits for them. */
  skippedAssemblies: Array<{ surface: string; entity: string; reason: string }>;
}

/**
 * Emit the adapter/module/barrel/aggregator layer for every (provider ×
 * emittable surface). Emit-once scaffolds are never overwritten; everything
 * else is re-emitted byte-identically.
 */
export function emitAdapters(opts: EmitAdaptersOptions): EmitAdaptersResult {
  const mode: RuntimeMode = opts.mode ?? "package";
  const result: EmitAdaptersResult = {
    written: [],
    scaffoldsWritten: [],
    scaffoldsSkipped: [],
    skippedSurfaces: [],
    assembliesWritten: [],
    tokensWritten: [],
    integrationAggregatorsWritten: [],
    skippedAssemblies: [],
  };
  const entitiesBySurface = collectEntitiesBySurface(opts.entities);
  // Index full entity definitions by name for the assembly/sink emission.
  const entityByName = new Map(opts.entities.map((e) => [e.entity.name, e]));

  // 'planned' providers are catalog-only roadmap stubs — adapters/assemblies
  // are emitted for active providers only.
  const activeProviders = opts.providers.filter((p) => isActiveProvider(p.definition));

  // surface → provider slugs that serve it AND have an emittable port.
  const bySurface = new Map<string, string[]>();
  for (const { definition } of activeProviders) {
    for (const surface of definition.surfaces) {
      if (!SURFACE_REGISTRY[surface]) {
        result.skippedSurfaces.push({
          provider: definition.slug,
          surface,
          reason: `no surface package for '${surface}' yet — add codegen-${surface} (Track C) to emit its adapters`,
        });
        continue;
      }
      const list = bySurface.get(surface) ?? [];
      list.push(definition.slug);
      bySurface.set(surface, list);
    }
  }

  const defBySlug = new Map(activeProviders.map((p) => [p.definition.slug, p.definition as ActiveProviderDefinition]));

  for (const [surface, slugs] of bySurface) {
    const surfaceDir = join(opts.outputRoot, surface);
    const adaptersDir = join(surfaceDir, "adapters");

    // Per-provider adapter scaffold (emit-once) + adapter module (@generated).
    for (const slug of slugs) {
      const def = defBySlug.get(slug)!;
      const providerDir = join(adaptersDir, slug);
      const scaffoldPath = join(providerDir, `${slug}-${surface}.adapter.ts`);
      const modulePath = join(providerDir, `${slug}-${surface}.adapter.module.ts`);

      // Emit-once: never overwrite an existing scaffold.
      if (existsSync(scaffoldPath)) {
        result.scaffoldsSkipped.push(scaffoldPath);
      } else {
        // Resolve each entity's DetectionConfig for THIS provider (RFC-0003 R3):
        // detection is provider-keyed on the entity, so index by the slug.
        const surfaceEntityNames = entitiesBySurface.get(surface) ?? [];
        const entityDetection = new Map<string, DetectionConfig>();
        for (const name of surfaceEntityNames) {
          const det = entityByName.get(name)?.entity.detection?.[slug];
          if (det) entityDetection.set(name, det);
        }
        const content = generateAdapterScaffold(
          def,
          surface,
          surfaceEntityNames,
          entityDetection,
          mode,
        );
        if (!opts.dryRun) writeFile(scaffoldPath, content);
        result.scaffoldsWritten.push(scaffoldPath);
      }

      const moduleContent = generateAdapterModule(def, surface);
      if (!opts.dryRun) writeIfChanged(modulePath, moduleContent);
      result.written.push(modulePath);
    }

    // Per-surface barrel + tokens + aggregator + typed view (@generated).
    const barrelPath = join(adaptersDir, "index.ts");
    const tokensPath = join(surfaceDir, `${surface}-adapters.tokens.ts`);
    const aggregatorPath = join(surfaceDir, `${surface}-adapters.module.ts`);
    const typedViewPath = join(surfaceDir, "types.generated.ts");
    const files: Array<[string, string]> = [
      [barrelPath, generateAdaptersBarrel(surface, slugs)],
      [tokensPath, generateSurfaceTokens(surface, mode)],
      [aggregatorPath, generateSurfaceAggregator(surface, slugs, mode)],
      [typedViewPath, generateTypedView(surface, slugs, entitiesBySurface.get(surface) ?? [])],
    ];
    for (const [path, content] of files) {
      if (!opts.dryRun) writeIfChanged(path, content);
      result.written.push(path);
    }

    // ------------------------------------------------------------------
    // RFC-0002 §2/§4 (E2) — per-entity assembly module + sink scaffold +
    // surface integration tokens.
    //
    // Skipped entirely when no `<backend_src>` root is supplied (the read-side
    // emitters are path-agnostic, but the assembly needs to resolve the entity
    // repo/module import specifiers). Per (surface, provider, entity-on-surface
    // with `pattern: Integrated`): emit the sink (emit-once) + assembly module
    // (@generated), collect the (entity, provider) token, then write the surface
    // tokens file once. A `surface:` entity that is NOT `pattern: Integrated` is
    // recorded in `skippedAssemblies` (read side still emitted) — never crashes.
    // ------------------------------------------------------------------
    if (opts.backendSrcAbs) {
      const aliases = opts.aliases ?? {};
      const surfaceEntities = entitiesBySurface.get(surface) ?? [];
      const tokenEntries: IntegrationTokenEntry[] = [];
      const assemblyEntries: IntegrationAssemblyEntry[] = [];
      const sinksDir = join(surfaceDir, "sinks");
      const modulesDir = join(surfaceDir, "modules");

      for (const entityName of surfaceEntities) {
        const def = entityByName.get(entityName);
        const pattern =
          def?.entity.pattern ??
          (Array.isArray(def?.entity.patterns) ? def?.entity.patterns?.[0] : undefined);
        if (pattern !== "Integrated") {
          // Record once per surface entity (not per provider — the reason is
          // pattern-level, not provider-level).
          result.skippedAssemblies.push({
            surface,
            entity: entityName,
            reason: `entity '${entityName}' declares surface '${surface}' but is not 'pattern: Integrated'` +
              `${pattern ? ` (got 'pattern: ${pattern}')` : " (no pattern declared)"} — ` +
              `the integration assembly + default sink need the Integrated projection/upsert path. ` +
              `Add 'pattern: Integrated' (or provide a hand-authored sink + assembly).`,
          });
          continue;
        }

        const plural = def?.entity.plural ?? `${entityName}s`;
        const context = def?.entity.context ?? null;
        const loc = resolveEntityModuleImports({
          entityName,
          entityPlural: plural,
          context,
          surface,
          // The sink+repo import is provider-agnostic; pick any provider's
          // module dir for the relative-path base (all share the same parent).
          provider: slugs[0],
          backendSrcAbs: opts.backendSrcAbs,
          aliases,
        });

        // Sink (emit-once scaffold) — provider-agnostic; one per entity.
        const sinkPath = join(sinksDir, `${entityName}.sink.ts`);
        if (existsSync(sinkPath)) {
          result.scaffoldsSkipped.push(sinkPath);
        } else {
          const sinkInput = buildSinkInput(def!, surface, slugs[0], loc.repoImportSpecifier);
          const sinkContent = generateDefaultSink({ ...sinkInput, mode });
          if (!opts.dryRun) writeFile(sinkPath, sinkContent);
          result.scaffoldsWritten.push(sinkPath);
        }

        // Per-(entity, provider) assembly module (@generated) + token entry.
        for (const slug of slugs) {
          const assemblyPath = join(
            modulesDir,
            slug,
            `${entityName}-integration.module.ts`,
          );
          const assemblyContent = generateAssemblyModule({
            surface,
            provider: slug,
            entityName,
            entityClass: loc.entityClass,
            moduleImportSpecifier: loc.moduleImportSpecifier,
            moduleClass: loc.moduleClass,
            repoImportSpecifier: loc.repoImportSpecifier,
            repoClass: loc.repoClass,
            sourceDesc: `definitions/providers/${slug}.yaml`,
            mode,
          });
          if (!opts.dryRun) writeIfChanged(assemblyPath, assemblyContent);
          result.assembliesWritten.push(assemblyPath);
          tokenEntries.push({ entityName, entityClass: loc.entityClass, provider: slug });
          assemblyEntries.push({ entityName, provider: slug });
        }
      }

      // Surface integration tokens (@generated) — one file per surface, all
      // (entity, provider) tokens. Emitted even when empty so the surface tree
      // is consistent (the assembly imports reference it).
      const integrationTokensPath = join(
        surfaceDir,
        `${surface}-integration.tokens.ts`,
      );
      const tokensContent = generateIntegrationTokens(surface, tokenEntries);
      if (!opts.dryRun) writeIfChanged(integrationTokensPath, tokensContent);
      result.tokensWritten.push(integrationTokensPath);

      // Surface integration aggregator (@generated, E3) — the AppModule entry
      // point. Imports + re-exports every per-entity assembly module so their
      // use-case tokens propagate to the app (RFC-0002 §1, §7 q3). Emitted only
      // when the surface has ≥1 assembly (skip surfaces whose entities were all
      // non-Integrated/skipped) — no empty aggregator on the graph.
      if (assemblyEntries.length > 0) {
        const integrationAggregatorPath = join(
          surfaceDir,
          `${surface}-integration.module.ts`,
        );
        const aggregatorContent = generateIntegrationAggregator(
          surface,
          assemblyEntries,
        );
        if (!opts.dryRun) writeIfChanged(integrationAggregatorPath, aggregatorContent);
        result.integrationAggregatorsWritten.push(integrationAggregatorPath);
      }
    }
  }

  return result;
}

/**
 * Derive the FK external-key write-surface name for a `belongs_to` relationship,
 * mirroring `processBelongsTo`'s `relationKey` branches in
 * `templates/entity/new/clean-lite-ps/prompt-extension.js:447-460`, then
 * appending `ExternalId`.
 *
 * Three shapes (see spec #487 anti-drift table):
 *   - self-FK  → `camelCase(foreign_key − _id) + 'ExternalId'`
 *     (e.g. `parent_account_id` + target `account` → `parentAccountExternalId`)
 *   - non-self → `target + 'ExternalId'` (target VERBATIM, snake retained)
 *     (e.g. target `account` → `accountExternalId`;
 *            target `sales_account` → `sales_accountExternalId`)
 *
 * The non-self snake-retention is a deliberate wart mirrored from the template:
 * `relationKey` is overloaded (also the Drizzle relation name + service accessor)
 * so normalising it here would corrupt generated consumer code. Normalization is
 * tracked as a follow-up (#494). Source of truth: prompt-extension.js:447-460.
 */
export function fkWriteKey(
  target: string,
  foreignKey: string,
  isSelfFk: boolean,
): string {
  if (isSelfFk) {
    // parent_account_id → parent_account → parentAccount
    const base = foreignKey.endsWith("_id") ? foreignKey.slice(0, -3) : foreignKey;
    return snakeToCamel(base) + "ExternalId";
  }
  // Non-self: target verbatim (may be snake, e.g. sales_account → sales_accountExternalId)
  return `${target}ExternalId`;
}

/**
 * Build the {@link SinkEmitInput} for a `pattern: Integrated` entity — mirrors
 * `buildIntegrationSurface().writeFields`/`writeFkFields` (clean-lite-ps
 * prompt-extension): copy-through scalars are the non-FK `fields:` (camelCased,
 * nullable-aware tsType); FK external keys are one `<relationKey>ExternalId` per
 * `belongs_to`. Uses {@link fkWriteKey} for the derivation so the write-key
 * matches the template's write-type member name for all three FK shapes.
 * The `generateDefaultSink` emitter throws if `pattern` is not
 * `Integrated` — the caller pre-filters, so this is only reached for Integrated.
 */
function buildSinkInput(
  def: EmitAdaptersEntity,
  surface: string,
  provider: string,
  repoImportSpecifier: string,
): SinkEmitInput {
  const fields = def.fields ?? {};
  const relationships = def.relationships ?? {};

  // FK column names (belongs_to foreign_key) — excluded from copy-through.
  const fkColumns = new Set<string>();
  for (const rel of Object.values(relationships)) {
    if (rel.type === "belongs_to" && typeof rel.foreign_key === "string") {
      fkColumns.add(rel.foreign_key);
    }
  }

  const copyThroughFields = Object.entries(fields)
    .filter(([name]) => name !== "id" && !fkColumns.has(name))
    .map(([name, f]) => ({
      camelName: snakeToCamel(name),
      tsType: tsTypeFor(f.type, f.nullable),
    }));

  // FK external keys — derived via fkWriteKey() which mirrors processBelongsTo's
  // relationKey branches (prompt-extension.js:447-460) exactly. isSelfFk is
  // detected the same way the template does: pluralize(target) === entityNamePlural
  // (prompt-extension.js:440-441).
  const entityNamePlural = def.entity.plural ?? `${def.entity.name}s`;
  const fkExternalKeys = Object.entries(relationships)
    .filter(([, rel]) => rel.type === "belongs_to")
    .map(([relName, rel]) => {
      const target = rel.target ?? relName;
      const foreignKey = rel.foreign_key ?? `${target}_id`;
      const isSelfFk = pluralize.plural(target) === entityNamePlural;
      return { writeKey: fkWriteKey(target, foreignKey, isSelfFk) };
    });

  return {
    entityName: def.entity.name,
    entityClass: pascalFromSnake(def.entity.name),
    surface,
    pattern: "Integrated",
    provider,
    copyThroughFields,
    fkExternalKeys,
    repoImportSpecifier,
  };
}

const TS_TYPE_FOR_SINK: Record<string, string> = {
  string: "string",
  integer: "number",
  decimal: "string",
  boolean: "boolean",
  uuid: "string",
  date: "Date",
  datetime: "Date",
  json: "unknown",
};

function tsTypeFor(type: string | undefined, nullable: boolean | undefined): string {
  const base = TS_TYPE_FOR_SINK[type ?? "string"] ?? "unknown";
  return nullable ? `${base} | null` : base;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function pascalFromSnake(s: string): string {
  const camel = snakeToCamel(s);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function writeFile(outPath: string, content: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
}

function writeIfChanged(outPath: string, content: string): void {
  if (existsSync(outPath) && statSync(outPath).isFile() && readFileSync(outPath, "utf-8") === content) {
    return;
  }
  writeFile(outPath, content);
}
