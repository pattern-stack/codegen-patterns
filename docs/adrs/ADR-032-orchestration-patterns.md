# ADR-032: Orchestration Patterns

**Status:** Accepted
**Date:** 2026-04-23
**Author:** Doug + Claude
**Relates to:** Issue #196, ADR-031 (App-Defined Patterns Phase 1), `docs/RFC-app-defined-patterns.md`, ADR-008 (Subsystem Architecture)
**Research notes:** `docs/specs/RFC-orchestration-patterns-research.md`

---

## Summary

ADR-031 shipped Phase 1 of App-Defined Patterns scoped to the domain trio — entity columns, repository base class, service base class. Its Decision 3 explicitly bounded the surface: "Patterns own the entity + repository + service trio … Controllers, DTOs, and frontend collections are projected downstream by codegen from that contract, not owned by the pattern." Cross-cutting orchestration — DI token registries, per-key factories, provider-dispatch tables — was named out of scope.

Real consumer code has now made that scope visible. In dealbrain-v2, the CRM module hand-wires two co-keyed registries (`CRM_PORT_REGISTRY`, `CRM_AUTH_STRATEGY_REGISTRY`) and a 12-parameter dispatcher (`CrmSyncFactory`) that reads `integration.provider` at runtime and selects the matching backend pair. This shape is not domain-trio code: it has no entity, no base class, no `patternConfig`. It is pure orchestration, and today it lives as ~90 lines of hand-written `crm.module.ts` providers plus a 160-line factory class.

This RFC proposes **Orchestration Patterns** as a second `pattern:` schema variant: a declarative way to describe a DI-token registry (or co-keyed registry group) keyed by a stable enum, with a generated dispatch skeleton that the consumer fills in at one or more named slots.

**Decisions locked 2026-04-23.** Priorities: type safety, testability, customizability, architectural clarity. Migration friction is explicitly NOT a criterion — the only consumer (dealbrain-v2) is a dogfood project. See Decisions 3, 4, 6, 7 below for the locked answers to what were previously Q1–Q4.

---

## Motivation

### The trigger case: dealbrain-v2 CRM sync

From the research notes:

- `src/modules/crm/crm.module.ts:269–277` builds `CRM_PORT_REGISTRY` as a `Map<CrmAdapterDomain, ICrmPort>` from two injected adapters.
- `src/modules/crm/crm.module.ts:278–294` builds `CRM_AUTH_STRATEGY_REGISTRY` as a `Map<CrmAdapterDomain, IAuthStrategy>` keyed by the same enum.
- `src/modules/crm/use-cases/crm-sync.factory.ts:64–152` injects both registries, reads a dispatch key, and selects one entry from each.

All three artifacts are boilerplate-shaped: the keys are a closed enum (`src/modules/crm/constants/adapter-domains.ts:8–14`), the values are interface-typed (`src/integrations/ports/crm.port.ts:143–215`), and the dispatch predicate is "read one field off the integration row."

### Why ADR-031 Phase 1 can't emit this

Phase 1's `PatternDefinition` shape (`docs/adrs/ADR-031-app-defined-patterns.md:30–77`) models columns, repository/service class references, and per-entity `patternConfig`. It has no slot for:

- A DI token identifier that multiple registries coordinate on.
- A registry's value-type interface (without emitting the interface itself).
- A dispatch function that consumes the registry and returns a per-call constructed object.
- A discriminator read from a runtime row, not from YAML.

Forcing Orchestration shape through Phase 1 would mean encoding a factory class as a "service base class" and lying about what `patternConfig` represents. The composition-conflict rules (`ADR-031-app-defined-patterns.md:110–120`) also assume one entity per pattern instance — orchestration patterns have no owning entity.

### Why this isn't the subsystem shape either

ADR-008 subsystems (events, jobs, cache, storage) use `DynamicModule.forRoot({ backend })` with a single backend class chosen at module construction. They do not support *key-dispatched multi-backend selection at request time*. The CRM module isn't picking a backend at boot — it is picking adapters per-request, keyed by data that lives on an integration row. That is a third shape, sibling to both Phase 1 Patterns and ADR-008 Subsystems.

---

## Locked Decisions Summary

Priorities that drove the picks: **type safety, testability, customizability, architectural clarity.** Migration friction was explicitly not a criterion.

| Decision | Picked | One-line rationale |
|---|---|---|
| Q1 → Decision 3 — DI token shape | **B** (codegen-derived typed TS constants) | One source of truth; token name derived from pattern name; no YAML leakage of Nest vocabulary. |
| Q2 → Decision 4 — Type safety | **B** (per-pattern typed dispatcher class with overloads) | Per-call narrowing + a testable runtime handle; YAML must enumerate concrete per-key types, which doubles as self-documentation. |
| Q3 → Decision 6 — Override mechanism | **B** (`forRoot({ overrides })` per-key) | Typed, declarative, covers both tests and runtime (feature flags, tenant-specific backends). |
| Q4 → Decision 7 — Artifact location | **C** (new `src/orchestration/` top-level) | Names the architectural layer; keeps "pattern defs" vs "pattern output" visually distinct; cross-cutting code lives in its own address, not hidden inside a feature module. |

Full tradeoff writeups for each locked decision appear under **Decisions** below.

---

## The Proposal

### `pattern: kind` discriminator

The existing `PatternDefinition` surface gains a `kind` field defaulted to `"domain"` (today's Phase 1 behaviour). Phase 3 adds `kind: "orchestration"`, which admits a different set of fields and rejects domain-trio fields (no `repositoryClass`, no `columns`, no `impliedBehaviors`).

```ts
export interface OrchestrationPatternDefinition {
  name: string;
  kind: "orchestration";
  registry: {
    // Resolution of `token` depends on Q1.
    token?: string;
    keyType: string;              // e.g. "CrmAdapterDomain" — imported path ref
    valueType: string;            // e.g. "ICrmPort" — imported path ref
    entries: Array<{
      key: string;                // e.g. "salesforce-crm"
      // Resolution of `provider` depends on Q1 + Q2.
      provider: string;           // DI token or class ref
    }>;
  };
  // Optional co-keyed sibling registries (addresses Candidate 2).
  coKeyedRegistries?: OrchestrationPatternDefinition["registry"][];
  dispatcher?: {
    className: string;            // e.g. "CrmSyncFactory"
    // The assembly body is a consumer-owned slot — pattern emits the
    // registry lookups + not-found throws, the consumer fills the body.
    assemblySlot: string;         // e.g. "build" — method name
  };
}
```

### Generated output (schematic — final layout depends on Q4)

For each orchestration pattern, codegen emits:

1. A token file (Q1 resolves shape).
2. A NestJS provider block that builds the `Map<K, V>` from the declared entries.
3. A dispatcher scaffold with the registry lookups + not-found throws pre-written, and a named slot for the consumer's assembly body.
4. A typing surface (Q2 resolves shape).

The consumer imports the generated module and invokes the dispatcher. The assembly slot is either a subclass override, a mixin, or a partial-class — depending on Q2.

### Composition rules (extending ADR-031 §3)

| Situation | Mode | Resolution |
|---|---|---|
| Two orchestration patterns declare the same name | Load-time hard error | Stop; names must be unique across all patterns. Enforced in Phase 3-1 by `loadAppPatterns()` (`registry.ts`) — the duplicate is rejected before it can silently overwrite. |
| An orchestration pattern references a `keyType` that codegen can't resolve | Phase 3-2 emission-time hard error | Phase 3-1 stores the type-alias string verbatim; resolution against the consumer's tsconfig requires the source-tree access codegen has during emission. |
| An orchestration pattern's entries reference a provider that isn't exported by any known module | Phase 3-2 emission-time warning | Same reason — Phase 3-1 records `provider: string`; Phase 3-2 emits the import; DI validates at boot. |
| A domain pattern and an orchestration pattern share a name | Generation-time hard error | Names live in one registry. Enforced in Phase 3-1 by `validateOrchestrationProject` as `pattern_name_collision`. |

These mirror ADR-031 §3's column-conflict rules. The Phase 3-1 validator additionally enforces three intra-pattern shape rules that are statically checkable from the registry record alone:

- **`pattern_entries_empty`** — a registry (primary or co-keyed) declared with `entries: []`.
- **`pattern_entry_malformed`** — an entry with a missing or non-string `key` / `provider`.
- **`pattern_entry_key_duplicate`** — two entries in the same registry sharing a `key`.
- **`pattern_cokeyed_keytype_mismatch`** — a co-keyed sibling whose `keyType` diverges from the primary registry's (Decision 2).

---

## Decisions

*Each decision is numbered, with rationale + alternatives rejected, following ADR-031's style. All eight decisions are locked as of 2026-04-23.*

### 1. Orchestration patterns are a second `kind`, not a separate primitive **(bound to the `pattern:` schema; does not hinge on Q1–Q4)**

Add `kind: "domain" | "orchestration"` to `PatternDefinition`. Default is `"domain"` to preserve Phase 1 behaviour. The two kinds share the discovery pipeline (`codegen.config.yaml patterns:` glob per ADR-031 §5) and the `definePattern()` identity function but have disjoint field sets.

**Rationale:** Consumers already learn "patterns are the extension seam." Introducing a parallel `orchestration:` top-level primitive would create a second vocabulary for the same mental concept (consumer-extensible declarative scaffolding). One concept, two shapes, shared discovery is cheaper to teach.

**Alternatives rejected:**
- **A separate `orchestration:` block in codegen config.** Would duplicate discovery, validation, and conflict detection. No decision the user makes about an orchestration pattern differs in shape from a domain-pattern decision — only the fields differ.
- **Overloading Phase 1 fields.** Encoding a factory as a "service base class" was evaluated and rejected: `patternConfig` has no owning entity in the orchestration case, and composition-conflict rules assume one entity per pattern.

### 2. Co-keyed registry groups are a first-class field, not two independent patterns **(does not hinge on Q1–Q4)**

The schema's `coKeyedRegistries` admits sibling registries that share the same key space. `CRM_PORT_REGISTRY` and `CRM_AUTH_STRATEGY_REGISTRY` declare together.

**Rationale:** In the canonical example the two registries are always dispatched together (`crm-sync.factory.ts:113–125`). Forcing them into separate patterns means the consumer repeats the `keyType` declaration and the dispatcher has to inject two independently-generated tokens. The research notes show this is the common case, not a rare one.

**Alternatives rejected:**
- **One pattern per registry with a shared key-space reference.** Pushes key-space coordination into the consumer; exactly the hand-wired cost Phase 3 is removing.
- **A generic "registry-group" primitive that doesn't know about registries.** Underspecified — the generated dispatcher needs to know entries are parallel-indexed to emit the lookup-and-throw pair.

### 3. DI token referencing: codegen-derived typed TS constants (Q1 → B)

The pattern's `name` is the single source of truth. YAML does not carry a `token:` field. Codegen emits `${PATTERN_NAME}_REGISTRY` as a unique `Symbol()` in a typed TS constants file co-located with the emitted module, along with a typed map alias.

```yaml
# consumer YAML — no token field
pattern: CrmPorts
kind: orchestration
```

```ts
// codegen-emitted src/orchestration/crm-ports/tokens.ts
export const CRM_PORTS_REGISTRY = Symbol('CRM_PORTS_REGISTRY');
export type CrmPortsRegistryMap = Map<CrmAdapterDomain, ICrmPort>;
```

**Rationale:** One source of truth (pattern name → token name) eliminates the "why did YAML say X but the generated file say Y" class of bugs. Unique `Symbol()` (not `Symbol.for(...)`) prevents cross-module collision. Typed map aliases give consumers a clean `@Inject(CRM_PORTS_REGISTRY) registry: CrmPortsRegistryMap` signature. The "no Nest vocabulary in YAML" invariant is preserved.

**Alternatives rejected:**
- **A (string symbols in YAML).** Preserves dealbrain-v2's existing `CRM_PORT_REGISTRY` identifier verbatim. Rejected — migration is not a criterion, and the YAML-to-emitted-code identifier drift isn't worth the verbatim-preservation win.
- **C (explicit `injectToken:` path-alias).** Honest about provenance, but forces every new pattern author to pre-create a token file — one more authoring step Phase 1 didn't require, and the "consumer picks the name" freedom isn't load-bearing when the only consumer is dogfood.

### 4. Type safety across registry entries: per-pattern typed dispatcher class (Q2 → B)

Codegen emits a `${PatternName}Dispatcher` class with one overload per entry. The YAML must enumerate each entry's concrete type (not just the interface), which codegen translates into overload signatures. The dispatcher is a NestJS provider — injectable, testable, extensible.

```yaml
pattern: CrmPorts
kind: orchestration
registry:
  keyType: CrmAdapterDomain
  valueType: ICrmPort
  entries:
    - key: salesforce-crm
      provider: SalesforceCrmAdapter    # concrete class, emits overload
    - key: hubspot-crm
      provider: HubSpotCrmAdapter
```

```ts
// codegen-emitted
@Injectable()
export class CrmPortsDispatcher {
  constructor(@Inject(CRM_PORTS_REGISTRY) private readonly registry: CrmPortsRegistryMap) {}

  select(key: 'salesforce-crm'): SalesforceCrmAdapter;
  select(key: 'hubspot-crm'): HubSpotCrmAdapter;
  select(key: CrmAdapterDomain): ICrmPort {
    const entry = this.registry.get(key);
    if (!entry) throw new CrmPortsDispatchError(`Unknown CrmAdapterDomain: ${key}`);
    return entry;
  }
}
```

**Rationale:** Narrowing works at every call site — `dispatcher.select('hubspot-crm')` resolves to `HubSpotCrmAdapter`, not `ICrmPort`. The dispatcher is a first-class DI citizen, which means `@OverrideProvider(CrmPortsDispatcher)` works out of the box and extensions (per-pattern methods beyond `select`) can be added via subclass in the assembly slot. Requiring YAML to enumerate concrete types doubles as self-documenting: reading the pattern file tells you exactly which backends exist.

**Alternatives rejected:**
- **A (generic factory with `as T` cast).** Minimum viable but untyped at the call site. Rejected — type safety was a locked priority.
- **C (conditional + template literal types).** Equally type-precise but purely type-level — no runtime handle to override or extend. Lacking a testable peg makes test-double injection harder than B, and the "no runtime class emitted" savings are negligible against the testability cost.

### 4. Type safety across registry entries **(bound to Q2 — pending human resolution)**

*This decision records whichever of Q2's options A, B, or C the reviewer chooses.*

### 5. Dispatch body is a named slot, not a declarative block

The pattern emits the dispatcher's constructor, registry lookups, and not-found throws. It does not emit the assembly body (the `new SyncCrmEntitiesUseCase({...})` call in `crm-sync.factory.ts:127–148`). The consumer provides that body by **subclassing the emitted dispatcher** — a direct consequence of Decision 4 (dispatcher is a class, so extension is `class CrmSyncDispatcher extends CrmPortsDispatcher { build(integrationId) { ... } }`).

**Rationale:** The research notes show the assembly body is 12 constructor arguments composed from ports, services, and repositories — consumer-specific orchestration that would require a mini-DSL to encode declaratively. Emitting boilerplate and leaving one method body to the consumer preserves the "codegen owns the boring parts" contract without creating a templating language.

**Alternatives rejected:**
- **Full declarative dispatcher bodies.** Would need an expression grammar for "construct this class, passing these dependencies, reading this field off the selected adapter." Every real-world case needs one more escape hatch than the previous.
- **No dispatcher at all — emit only the registry.** Loses the not-found-throw safety that CRM already has and leaves the consumer with identical hand-written boilerplate.

### 6. Override escape hatch: `forRoot({ overrides })` per-key (Q3 → B)

The emitted module is a `DynamicModule` with a `forRoot(opts?)` that accepts per-key overrides typed against the registry's key space and value type.

```ts
// codegen-emitted
@Module({})
export class CrmPortsOrchestrationModule {
  static forRoot(opts?: {
    overrides?: Partial<Record<CrmAdapterDomain, ICrmPort>>;
  }): DynamicModule {
    return {
      module: CrmPortsOrchestrationModule,
      providers: [
        {
          provide: CRM_PORTS_REGISTRY,
          useFactory: (...entries: ICrmPort[]) => {
            const base: CrmPortsRegistryMap = new Map([
              ['salesforce-crm', entries[0]],
              ['hubspot-crm', entries[1]],
            ]);
            if (opts?.overrides) {
              for (const [k, v] of Object.entries(opts.overrides)) {
                base.set(k as CrmAdapterDomain, v);
              }
            }
            return Object.freeze(base);  // frozen after forRoot
          },
          inject: [SalesforceCrmAdapter, HubSpotCrmAdapter],
        },
        CrmPortsDispatcher,
      ],
      exports: [CRM_PORTS_REGISTRY, CrmPortsDispatcher],
    };
  }
}
```

```ts
// test usage
imports: [CrmPortsOrchestrationModule.forRoot({
  overrides: { 'salesforce-crm': new FakeSfdcAdapter() }
})]

// production usage — defaults wired from the registry entries
imports: [CrmPortsOrchestrationModule.forRoot()]
```

**Rationale:** Typed per-key override covers both tests (mock one backend) and runtime (feature-flag a backend, tenant-specific variants). The Map is frozen after `forRoot` evaluation, which rules out the "mutable-registry ordering bug" failure mode the tradeoff discussion flagged. `forRoot` shape is consistent with every ADR-008 subsystem already — consumers know the idiom.

**Alternatives rejected:**
- **A (`@OverrideProvider` + full Map rebuild).** Idiomatic Nest but requires consumers to rebuild the entire Map to replace one entry. Noisy and regression-prone.
- **C (separate test-only module).** Doubles the module count per pattern and doesn't cover runtime overrides. Solves only half the problem.

### 7. Emitted-artifact location: new `src/orchestration/` top-level layer (Q4 → C)

A new `paths.orchestration_src` config key (default `src/orchestration/`) defines where orchestration patterns emit their artifacts. Each pattern gets its own subdirectory:

```
src/orchestration/
├── crm-ports/
│   ├── tokens.ts
│   ├── registry.providers.ts
│   ├── dispatcher.ts
│   ├── index.ts           # re-exports the module + dispatcher + tokens
│   └── module.ts          # CrmPortsOrchestrationModule
└── email-providers/        # (future pattern)
    └── ...
```

**Rationale:** Orchestration code is cross-cutting by definition. Burying it inside `src/modules/crm/generated/` (Option A) implies it "belongs to" the CRM module when in reality it coordinates across CRM + integrations + events. Placing it under `src/patterns/generated/` (Option B) blurs the line between hand-authored pattern definitions (`src/patterns/*.pattern.ts`) and generated pattern output. A distinct `src/orchestration/` names the architectural layer explicitly — same way `src/modules/` names the domain layer and `src/subsystems/` names the infra layer. Consumers grep one directory to see every orchestration surface the app exposes.

**Alternatives rejected:**
- **A (`src/modules/*/generated/`).** Lowest-friction migration, but mis-locates cross-cutting code inside a single feature module. Rejected once migration friction was dropped as a criterion.
- **B (`src/patterns/generated/`).** Symmetrical with Phase 1 authoring but mixes two concerns (definitions + output) under one parent directory. Less clear architectural story.

### 8. Orchestration patterns do not compose with domain patterns at the entity surface

A YAML entity declaration can reference `pattern: Synced` or `patterns: [CrmEntity, Event]` as today — both domain-kind. Orchestration patterns are never referenced from an entity YAML; they stand alone in `src/patterns/*.pattern.ts` and emit their own module. Composition with domain patterns is indirect: the orchestration pattern's entries may reference DI-registered services that were themselves generated by domain patterns.

**Rationale:** ADR-031 Decision 2 scoped the entity `pattern:` / `patterns:` fields to domain-kind patterns. Extending them to orchestration kinds would require answering "what does `pattern: CrmPorts` mean on an entity?" — and the answer is "nothing, it isn't an entity pattern." Keep the surfaces disjoint.

**Alternatives rejected:**
- **A `usesOrchestration:` field on entity YAML.** Unnecessary — an entity that wants to call a dispatcher injects it from the pattern-generated module, same as any other NestJS provider.

---

## Implementation sequence

**Phase 3-1 — Schema + registry discovery (upstream).** *Shipped.*
1. Extend `PatternDefinition` with `kind` discriminator + add disjoint `OrchestrationPatternDefinition` shape (`src/patterns/pattern-definition.ts`).
2. Extend the pattern discovery pipeline (ADR-031 §5) to route orchestration patterns to a separate `ORCHESTRATION_APP_PATTERNS` map (`src/patterns/registry.ts`); domain map gains symmetric duplicate-name protection in the same change.
3. Add the orchestration conflict detector (`src/patterns/validate-orchestration.ts`), mirroring `src/patterns/validate-composition.ts`. Wired into `analyzeDomain()`. Issues emitted: `pattern_name_collision`, `pattern_entries_empty`, `pattern_entry_malformed`, `pattern_entry_key_duplicate`, `pattern_cokeyed_keytype_mismatch`. Loader-time `LoadAppPatternsResult.errors` carries the orchestration ↔ orchestration name-duplicate case (caught before the silent-overwrite window).
4. **No code emission yet.** Validation + schema only.

**Phase 3-2 — Token + registry emission (upstream).** *Shipped 2026-04-25.*
1. Emit the token file per Decision 3 (codegen-derived `Symbol()` + typed map alias).
2. Emit the `DynamicModule` with `forRoot({ overrides })` plumbing per Decision 6 (frozen-after-construction Map).
3. Byte-identical-output test: generate against a fixture modeled on `CRM_PORT_REGISTRY` and diff against a hand-written golden file.

**Phase 3-3 — Dispatcher scaffold emission (upstream).** *Shipped 2026-04-25.*
1. Emit the `${PatternName}Dispatcher` class per Decision 4 (overload signatures from entries).
2. Emit the assembly-slot contract: the dispatcher is subclassable; consumer extends it and adds their assembly method(s) per Decision 5.
3. Land all emitted artifacts under `${paths.orchestration_src}/${pattern-slug}/` (default `${backend_src}/orchestration/`) per Decision 7.

Implementation locked these refinements during Phase 3-2/3 build (see `docs/specs/PHASE-3-2-3-emission-plan.md` §5.1 for the operator gates and §6.1 for post-ship notes):

- O-1: Co-keyed siblings carry an explicit `name:` field; `${PATTERN_CONST}_${NAME_UPPER}_REGISTRY` token + `select${NamePascal}(...)` method are derived from it. No auto-stripping of `I`/`Strategy`/`Port`/`Adapter`/`Provider`.
- O-2: Pure-TS template literals (no Hygen). Generator lives in `src/cli/shared/orchestration-generator.ts`.
- O-3: `OrchestrationRegistrySpec` carries optional `keyTypeImport`, `valueTypeImport`, and per-entry `providerImport`. Missing fields are rejected at emission time as `pattern_missing_import_path`.
- O-4: Dispatcher base emits nothing for `assemblySlot` beyond a documentation comment (issue #224 tracks unifying observability hooks across all pattern-emitted bases).
- O-6: Default `paths.orchestration_src` is `${backend_src}/orchestration`.
- O-7: Top-level `${orchestration_src}/index.ts` re-exports each pattern's per-pattern barrel; only emitted when ≥1 pattern is registered.
- New CLI verb `codegen orchestration {gen|list|validate}`; `entity new` invokes the same generator as a non-fatal post-step so `just gen-all` keeps building everything.

**Phase 3-4 — First consumer migration (dealbrain-v2).**
1. Author `src/patterns/crm-ports.pattern.ts` with the two co-keyed registries + dispatcher slot.
2. Delete `CRM_PORT_REGISTRY` / `CRM_AUTH_STRATEGY_REGISTRY` provider blocks from `crm.module.ts:269–294`.
3. Fill the assembly slot for `CrmSyncFactory.build`.
4. Verify smoke tests pass; compare generated code against the hand-written baseline.

**Phase 3-5 — Override + testability (consumer validation).**
1. `forRoot({ overrides })` was emitted in Phase 3-2 — this step validates it end-to-end.
2. Port one dealbrain-v2 test to use the override pathway (mock HubSpot adapter via `forRoot({ overrides: { 'hubspot-crm': fake } })`).

**Phase 3-6 — Catalog expansion.**
1. Document the pattern for future consumers.
2. Scan for secondary candidates (the research notes flagged candidates #3 partial — evaluate whether the factory's dispatch-skeleton logic itself is worth emitting, or whether Phase 3-2 + 3-3 are sufficient).

---

## Not in Scope

- **Frontend orchestration surfaces.** Backend only, matching Phase 1.
- **Runtime pattern-definition evaluation.** Orchestration patterns are codegen-time constructs; the generated output is plain NestJS.
- **Env/config provider shapes** (research notes candidate #4). A separate RFC if/when the need is proven.
- **Dispatcher assembly grammars.** Decision 5 locks "subclass-and-fill" over "declarative body"; no expression language is added.
- **Cross-module pattern references.** Each orchestration pattern emits one module-sized unit. Cross-module coordination remains hand-wired (via Nest imports) until a second consumer demands otherwise.

---

## References

- ADR-031 — App-Defined Patterns (Phase 1): `docs/adrs/ADR-031-app-defined-patterns.md`
- RFC-app-defined-patterns: `docs/RFC-app-defined-patterns.md`
- Research notes (candidates + fit assessment): `docs/specs/RFC-orchestration-patterns-research.md`
- Canonical consumer — CRM module: `/Users/dug/Downloads/dealbrain-v2/src/modules/crm/crm.module.ts:269–294`
- Canonical consumer — dispatcher: `/Users/dug/Downloads/dealbrain-v2/src/modules/crm/use-cases/crm-sync.factory.ts:64–152`
- Canonical consumer — token file: `/Users/dug/Downloads/dealbrain-v2/src/modules/crm/wiring/constants.ts`
- ADR-008 — Subsystem architecture (sibling shape, not parent): `docs/adrs/ADR-008-*.md`
