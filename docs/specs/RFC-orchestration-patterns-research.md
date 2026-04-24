# Orchestration Patterns — Research Notes

**Relates to:** Issue #196, ADR-031 (App-Defined Patterns Phase 1), `docs/RFC-app-defined-patterns.md`
**Date:** 2026-04-22
**Author:** Claude (understand phase)
**Scope:** Survey of hand-wired cross-cutting registries, factories, and dispatch tables in reachable consumers. Informs the Phase 3 RFC.

## Method

Searched upstream (`/Users/dug/Projects/codegen-patterns`) and the canonical consumer (`/Users/dug/Downloads/dealbrain-v2`) for module-level `useFactory` + `inject` shapes that build `Map<K, V>`-typed providers, classes suffixed `Factory` that dispatch on a runtime key, and DI tokens named `*_REGISTRY`. Each candidate is assessed on whether a declarative `pattern:` schema could emit it without bloating the authoring surface.

## Candidate 1 — `CRM_PORT_REGISTRY` (canonical)

- **Path:** `/Users/dug/Downloads/dealbrain-v2/src/modules/crm/crm.module.ts:269–277`
- **Token:** `CRM_PORT_REGISTRY` declared at `src/modules/crm/wiring/constants.ts:2`
- **Registers:** `Map<CrmAdapterDomain, ICrmPort>` — keyed by `'salesforce-crm' | 'hubspot-crm'` (see `src/modules/crm/constants/adapter-domains.ts:8–14`), valued as the port interface at `src/integrations/ports/crm.port.ts:143–215`.
- **Resolution at runtime:** `CrmSyncFactory` (`src/modules/crm/use-cases/crm-sync.factory.ts:68–71, 113–118`) loads an `integration` row, reads `integration.provider`, and calls `this.adapters.get(provider)` to select the adapter. Unknown provider → loud throw.
- **Injected deps + timing:** The registry's `useFactory` injects `SalesforceCrmAdapter` + `HubSpotCrmAdapter` at module boot. The adapters themselves are composed providers — `SalesforceCrmAdapter` receives `CRM_AUTH_STRATEGY` (`crm.module.ts:243–248`), `HubSpotCrmAdapter` receives `HubSpotAuthStrategy` + `FieldDefinitionService` (`crm.module.ts:249–268`).
- **Fit for Phase 3 pattern:** **Excellent.** This is the archetype: a Map built from a fixed set of backends keyed by a stable enum, consumed by one factory. A pattern of shape `{ token, keyType, entries: [{ key, provider, inject }] }` generates it verbatim.

## Candidate 2 — `CRM_AUTH_STRATEGY_REGISTRY` (sibling)

- **Path:** `/Users/dug/Downloads/dealbrain-v2/src/modules/crm/crm.module.ts:278–294`
- **Token:** `CRM_AUTH_STRATEGY_REGISTRY` at `src/modules/crm/wiring/constants.ts:22`
- **Registers:** `Map<CrmAdapterDomain, IAuthStrategy>` — same key space as Candidate 1, values are `IAuthStrategy` (`src/integrations/ports/crm.port.ts:57–62`).
- **Resolution at runtime:** Same factory as Candidate 1; `CrmSyncFactory` reads `this.authStrategies.get(provider)` at `crm-sync.factory.ts:120–125` one line after the port lookup. Sibling by design — the commit message notes that before it existed, SFDC auth leaked into HubSpot dispatch.
- **Injected deps + timing:** Injects `CRM_AUTH_STRATEGY` (SFDC, itself a factory-built provider) + `HubSpotAuthStrategy` (registered by class) at module boot.
- **Fit for Phase 3 pattern:** **Excellent, and reinforces Candidate 1.** Two registries keyed by the same enum, dispatched together in one factory. Suggests the Phase 3 pattern should support **co-keyed registry groups** — "ports + auth-strategies share CrmAdapterDomain as key" — rather than forcing N single-key declarations.

## Candidate 3 — `CrmSyncFactory` itself (the dispatcher)

- **Path:** `/Users/dug/Downloads/dealbrain-v2/src/modules/crm/use-cases/crm-sync.factory.ts:64–152`
- **Shape:** `@Injectable()` class whose `build(integrationId)` method: (a) loads a row, (b) reads the dispatch key, (c) validates it against a known-domain guard (`isKnownDomain`, line 154), (d) pulls one entry from each co-keyed registry, (e) constructs a configured `SyncCrmEntitiesUseCase` with ~12 collaborators.
- **Injected deps:** `IntegrationRepository`, both registries, `SYNC_SUBSCRIPTION_STORE`, `LOOPBACK_FINGERPRINT_STORE`, `DRIZZLE`, four entity services + four repositories, `TYPED_EVENT_BUS`. Twelve constructor parameters.
- **Fit for Phase 3 pattern:** **Partial.** The registry-lookup + not-found-throw boilerplate is pattern-friendly (codegen can emit that directly). The 12-arg constructor and the concrete `new SyncCrmEntitiesUseCase({...})` assembly is consumer-specific orchestration logic. A Phase 3 pattern should emit the *dispatch skeleton* (constructor boilerplate, registry lookups, not-found throws) and leave the *assembly body* as a named template slot the consumer fills in — attempting to declaratively describe "how to wire 12 services into a use case" bloats the schema into a mini-DSL.

## Candidate 4 — OAuth config + redirect providers (SFDC + HubSpot)

- **Paths:** `crm.module.ts:109–140` (SFDC), `crm.module.ts:182–210` (HubSpot)
- **Shape:** Four `useFactory` providers that read `process.env.*` into typed config records (`SalesforceOAuthConfig`, `SalesforceOAuthRedirects`, `HubSpotOAuthConfig`, `HubSpotOAuthRedirects`) with dev-mode placeholder fallbacks.
- **Fit for Phase 3 pattern:** **Edge case — do not include.** These are env-adapter providers, not registries. They fit the separate `config`/`env` subsystem conversation, not orchestration. A pattern that tries to cover env-driven provider bodies would need an expression language for "if env X is unset, fall back to Y" — out of scope.

## Candidate 5 — Per-provider OAuth use-case + strategy providers

- **Paths:** `crm.module.ts:141–158` (`CRM_AUTH_STRATEGY` SFDC), `crm.module.ts:211–226` (`HubSpotAuthStrategy` by class), `crm.module.ts:166–180` + `227–241` (OAuth use cases)
- **Shape:** Factory-built `new Strategy({ deps })` providers, one per integration vendor. No Map — callers either inject the one token or inject by class.
- **Fit for Phase 3 pattern:** **Indirectly.** These feed Candidate 2. A Phase 3 pattern that declares the `CRM_AUTH_STRATEGY_REGISTRY` needs to know its entries reference existing providers (`CRM_AUTH_STRATEGY`, `HubSpotAuthStrategy`) — meaning the schema needs a provider-reference field that can name either a token or a class. This is the DI-token question (Q1).

## Candidate 6 — `SyncCrmEntitiesUseCase` inner-wiring (sync ports)

- **Path:** `/Users/dug/Downloads/dealbrain-v2/src/modules/crm/wiring/entity-sync-ports.ts:35–131`
- **Shape:** Factory functions (`createOpportunitySyncPort`, `createAccountSyncPort`, etc.) that adapt codegen-generated services to narrow port interfaces. No DI token, no registry — plain module-level functions called from `CrmSyncFactory.build` (lines 133–147).
- **Fit for Phase 3 pattern:** **Edge case — do not include.** This is adapter/translator code, not dispatch. The shape is per-entity-type translation — generic enough that it could be generated, but it belongs to the sync-engine RFC (#60 / `syncable:`), not orchestration.

## Candidate 7 — `CRM_TX_RUNNER`, `SYNC_SUBSCRIPTION_STORE`, `LOOPBACK_FINGERPRINT_STORE`

- **Paths:** `crm.module.ts:300–311`; tokens at `wiring/constants.ts:8–11, 25`
- **Shape:** Singleton providers. Each factory builds one instance (`new StubSyncSubscriptionStore()`, etc.).
- **Fit for Phase 3 pattern:** **Edge case — do not include.** These are single-provider DI bindings, not registries. A Phase 3 pattern that tried to subsume every `useFactory` shape would collapse into "write any NestJS provider declaratively" — architecturally wrong. Phase 3 owns the **key → provider-collection → dispatch** shape only.

## Upstream (codegen-patterns) search

Searched `/Users/dug/Projects/codegen-patterns/runtime/subsystems/` (events, jobs, cache, storage) for registry-style providers.

- **Finding:** The four library subsystems use `DynamicModule.forRoot({ backend })` with a single backend-class switch — not Map-keyed registries. Job handler discovery (`@JobHandler` decorator + module-scan) is a dispatch mechanism, but it is **not hand-wired by the consumer**; it's decorator-driven and internal to the jobs subsystem.
- **Implication:** There is no existing upstream shape that resembles `CRM_PORT_REGISTRY`. Phase 3 introduces a genuinely new primitive. The `IJobQueue` + handler dispatch inside the jobs subsystem is the closest internal analogue, but it is not a codegen-authored registry — it's subsystem-internal runtime machinery.

## Summary Table

| # | Candidate | Fit | Notes |
|---|---|---|---|
| 1 | `CRM_PORT_REGISTRY` | Core fit | Archetype for Phase 3 schema |
| 2 | `CRM_AUTH_STRATEGY_REGISTRY` | Core fit | Co-keyed with #1 — motivates registry groups |
| 3 | `CrmSyncFactory` (dispatcher) | Partial fit | Dispatch skeleton yes, assembly body no |
| 4 | OAuth env config providers | Edge — exclude | Env subsystem, not orchestration |
| 5 | Per-vendor strategy providers | Referenced by #2 | Drives the DI-token reference question (Q1) |
| 6 | Entity sync-port factory functions | Edge — exclude | Belongs to sync-engine RFC |
| 7 | Tx runner + stub stores | Edge — exclude | Single-provider, not registry-shaped |

## Conclusions for the RFC

1. **Phase 3's scope is narrow.** Three candidates (#1, #2, #3) motivate the primitive. Everything else is a separate subsystem or a per-shot provider that doesn't justify a new declarative surface.
2. **Co-keyed registry groups matter.** #1 and #2 share `CrmAdapterDomain` and are dispatched together. The schema should model that explicitly, not force two independent `pattern:` declarations.
3. **The dispatcher's assembly body is a hole.** #3 shows codegen cannot reasonably own how a consumer composes a use case from 12 services. The pattern emits the dispatch skeleton; the consumer fills in an assembly slot (function, or method-override).
4. **No upstream precedent.** The primitive is new — Phase 3 is not refactoring an internal shape, it is promoting a consumer shape into the codegen contract.
