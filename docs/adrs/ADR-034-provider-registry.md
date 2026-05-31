# ADR-034 — Project-Level Provider Registry

> **Superseded by [RFC-0001](../rfcs/RFC-0001-integration-codegen-retarget.md) (see §1, §8).**
> The project-level provider registry is no longer a `codegen.config.yaml`
> `providers:` block; provider truth moves to first-class
> `definitions/providers/<provider>.yaml` artifacts (slug + auth + client +
> surfaces), which carry strictly more than the config block did. The
> cross-subsystem "what providers is this app connected to" question is
> answered by scanning that directory. Do not implement the `providers:` config
> block below. Schema + validator landed in Track D · D1 (#396).

**Status:** Superseded by RFC-0001
**Date:** 2026-04-26
**Owner:** Doug
**Related:** ADR-033 (config-driven change sources), ADR-033.1 (provider-keyed `detection:` — tightens validation), ADR-031-auth-subsystem, ADR-025 (combiner subsystems), epic #242 (audit-tier)
**Tracks:** RFC #241 Open Question 1 (within-file vs. project-level provider validation)

## Context

Multiple subsystems independently care about "what external providers is this app connected to":

- **Sync** (ADR-033, ADR-033.1) — entity YAML's `sync.providers:` and `detection:` blocks are keyed by provider name; typos and forgotten registrations are the dominant validation gap (ADR-033.1 §6).
- **Auth** (ADR-031-auth-subsystem) — OAuth provider configs, redirect URIs, token storage policy are per-provider concerns.
- **Observability / audit-tier** (ADR-025, epic #242) — bridge metrics, audit events, and lifecycle reporters increasingly need to filter, group, and label by provider.
- **Webhook ingestion** — inbound webhook routing assigns staging tables and signing-secret resolution per provider.

Today each subsystem declares its provider list locally and there is no shared source of truth. Entity YAML's `sync.providers:` lists provider names against the entity. Auth config (consumer-side, today) lists OAuth providers against the app. Audit reporters synthesize provider lists by scanning sync runs. The information is the same; the storage is duplicated; drift is mechanical.

ADR-033.1 deliberately scopes its provider-name validation to a **within-file** cross-check (entity's `detection:` keys ⊆ entity's `sync.providers:` keys). This catches the practical typo class without inventing new config surface. It does not catch the case where an entity declares a provider that exists nowhere else in the project, and it does not give other subsystems a place to look when they ask the same question.

This ADR introduces a **project-level provider registry** as the single source of truth for "what is this app externally connected to." It is owned by `codegen.config.yaml`, validated at config-load time, and consumed by every subsystem that needs the answer.

## Decision

### 1. Registry lives in `codegen.config.yaml`

A new top-level `providers:` block is added to the project config schema. The block is a `Record<string, ProviderRegistryEntry>` keyed by provider id (the same string used as map keys throughout entity YAML, sync subscriptions, and audit rows).

```yaml
# codegen.config.yaml
providers:
  hubspot-crm:
    display_name: 'HubSpot CRM'
    kind: 'crm'
    auth: 'oauth2'
    sandbox: false
  salesforce-crm:
    display_name: 'Salesforce CRM'
    kind: 'crm'
    auth: 'oauth2'
    sandbox: false
  stripe:
    display_name: 'Stripe'
    kind: 'billing'
    auth: 'api-key'
    sandbox: true
```

### 2. Minimal v1 entry shape

The v1 `ProviderRegistryEntry` schema is deliberately small. Only fields with at least one concrete consumer ship in this ADR; richer metadata is added per-field by follow-on ADRs that introduce the consumer.

```ts
export const ProviderRegistryEntrySchema = z.object({
  display_name: z.string().min(1),
  kind: z.string().min(1),                   // free-form; e.g. 'crm', 'billing', 'comms'
  auth: z.enum(['oauth2', 'api-key', 'webhook-secret', 'none']),
  sandbox: z.boolean().optional().default(false),
});

export const ProviderRegistrySchema = z
  .record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/), ProviderRegistryEntrySchema);
```

Provider id format: lowercase, alphanumeric + hyphen, must start with alphanumeric. Matches the de facto shape already used in entity YAML keys.

### 3. Cross-subsystem validation tightens at config-load time

The codegen config loader validates the registry at load time and exposes the parsed registry through the existing `loadConfig()` API. Subsystems consume it as follows:

- **Sync (ADR-033.1 tightening)** — the `superRefine` validator extends with a second loop: every key in an entity's `sync.providers:` must exist in `providers:`. Failure surfaces `pts codegen entity validate` with `Provider 'hubspot-cmr' in entity 'opportunity.sync.providers' is not declared in codegen.config.yaml#/providers`.
- **Auth** — when ADR-031-auth-subsystem's OAuth config emission lands, OAuth provider configs must reference a registry entry with `auth: 'oauth2'`.
- **Audit-tier (epic #242)** — provider-faceted reporters consume `Object.keys(providers)` for filter UIs and label vocabularies.

Within-file checks from ADR-033.1 §6 stay in place; the project-level check is additive, not a replacement.

### 4. Registry is configuration-time data, not runtime DI

The registry is parsed at `loadConfig()` time and serialized into codegen output where needed. It is **not** injected as a runtime NestJS provider. Two reasons:

- The registry is YAML config, not application state — the same decision shape as `codegen.config.yaml: paths`, `naming`, etc. Wiring it through NestJS DI would imply the consumer reads it at request time, which is not a use case anyone has.
- Audit-tier and other consumers that need provider metadata at runtime get it via codegen-emitted typed artifacts (a follow-on to ADR-033.2 — see Open Questions §1), not through DI lookup.

### 5. No runtime registry mutation

The registry is the project's static manifest of external connections. Adding a connection is a YAML edit + regenerate step. Dynamic provider plugins (loading providers at runtime) and cross-tenant registries are explicitly out of scope. If the use case ever surfaces, it will be a separate ADR — the static registry is not the seam to bend for it.

### 6. Per-provider config secrets stay out

The registry holds *identity* and *type* metadata, not *configuration secrets*. OAuth client IDs, API keys, webhook signing secrets, base URLs — these stay in environment variables and are looked up at runtime by subsystem-specific code. Entries in the registry name the providers; secrets are bound by name in the consumer's deployment config.

This matches the existing convention (the codebase has no notion of secrets in YAML config today) and keeps the registry safe to commit, generate from, and surface in audit UIs.

### 7. Forward-references from ADR-033.1 resolve here

ADR-033.1 §6 forward-references this ADR for the project-level cross-check. When this ADR's PR lands:

1. The `superRefine` in `EntityDefinitionSchema` extends with the second loop described in §3.
2. ADR-033.1 gets an inline note that the project-level check is now active.
3. Existing entity YAMLs are checked against the new validator; any drift surfaces in `just validate-entities`.

## Rationale

- **Why a separate ADR (not folded into ADR-033.1).** The registry serves auth, observability, audit-tier, and webhook ingestion in addition to sync. Filing the registry under ADR-033.1 would misattribute a project-wide concern to a sync extension. A separate ADR keeps the audit trail honest: future subsystems consuming the registry cite ADR-034, not a sync ADR.
- **Why minimal v1 entry shape.** Every metadata field the registry might carry (rate limits, retry policies, OAuth scopes, sandbox URLs, regional endpoints) has a plausible argument and zero current consumers. CLAUDE.md "no half-finished implementations" — fields land when the consumer that reads them lands.
- **Why config-time, not runtime DI.** The registry is a static manifest, parsed once. NestJS DI is the wrong primitive for it; configuration loading is the right primitive. Codegen output bridges the static-to-runtime gap where needed.
- **Why a record (not an enum).** Same reasoning as ADR-033.1 §7 (`z.record` over `z.enum`) — keeps the schema a static export, avoids factory-schema ripple, keeps error messages readable.
- **Why no secrets.** Secrets in YAML is a known anti-pattern; the registry stays a manifest, not a credential store.

## Consequences

**Positive:**
- Single source of truth for "what is this app connected to" — replaces three parallel implicit registries (entity YAML aggregation, auth config, audit synthesis).
- ADR-033.1's `superRefine` tightens to catch the full provider-typo class. Entity YAML can no longer reference a provider that exists nowhere else in the project.
- Cross-subsystem features (provider-aware audit reporting, OAuth-config codegen, webhook-secret resolution) get a manifest to consult rather than reinventing one.
- Provides the seed for a project-wide `AppProvider` literal-union type (ADR-033.2 Open Question 2) — derivable from the registry as a single declaration.

**Negative / costs:**
- Adds new top-level config surface. Mitigation: minimal v1 schema; new fields land only when a consumer needs them.
- Existing entity YAMLs must declare every provider in the registry to pass validation. Mitigation: `pts codegen entity validate` flags drift at validate-time; the registry is greenfield (no existing consumer ships with codegen-patterns yet) so the migration cost is zero in-tree and one-time downstream.
- A second source of truth for provider names exists alongside the entity YAMLs that reference them. Mitigation: that's the point — entity YAMLs become *references* to the registry, not redeclarations. Validation enforces consistency.

**Out of scope:**
- Per-provider runtime config (OAuth client IDs, base URLs, rate limits) — bound at deployment, not in YAML.
- Dynamic provider plugins / runtime registry mutation — explicitly rejected per §5.
- Cross-tenant provider registries — single-app registry only; multi-tenant providers are a per-deployment concern.
- Migration tooling for consumers transitioning from implicit provider lists to the registry — none ship today.
- The provider-faceted audit reporting itself (epic #242 owns) — this ADR exposes the registry; #242 consumes it.

## Open questions

1. **Should the registry emit a typed artifact?** A natural follow-on to ADR-033.2 is to emit a project-wide `src/codegen/providers.ts`:

   ```ts
   export const APP_PROVIDERS = ['hubspot-crm', 'salesforce-crm', 'stripe'] as const;
   export type AppProvider = (typeof APP_PROVIDERS)[number];
   export const APP_PROVIDER_REGISTRY: Record<AppProvider, ProviderRegistryEntry> = { ... };
   ```

   Per-entity `<EntityName>Provider` types from ADR-033.2 would narrow `AppProvider` (`OpportunityProvider extends AppProvider`). Recommend deferring to a follow-on ADR (ADR-034.1?) once a consumer demands cross-entity typed provider access.

2. **Does `kind` need an enum?** v1 is free-form (`'crm'`, `'billing'`, `'comms'`). An enum would tighten validation but pre-commits to a vocabulary. Recommend free-form for v1; tighten if/when a consumer needs the discriminator.

3. **Should the registry support aliases?** Some providers ship under multiple brand names (e.g., HubSpot CRM Hub vs. HubSpot Marketing Hub) but share an OAuth app and SDK. Aliases would let one registry entry back multiple keys. Defer until a real case appears — the easy answer (separate registry entries per key) covers everything we currently see.

## Implementation map

| Issue | Lands |
|---|---|
| **ADR-034 PR** | This ADR; `ProviderRegistrySchema` in `src/config/`; `codegen.config.yaml` schema extension; `loadConfig()` returns parsed registry; ADR-033.1 `superRefine` extended with project-level cross-check; `just validate-entities` covers the new check; smoke fixture gains a `providers:` block |
| **Follow-on (ADR-034.1?)** | Typed `src/codegen/providers.ts` artifact; `AppProvider` union; entity-scoped `<EntityName>Provider` types narrow `AppProvider` |
| **Audit-tier (#242)** | Provider-faceted reporters consume the registry for filter vocabularies |
| **Auth (ADR-031-auth-subsystem)** | OAuth config emission references registry entries with `auth: 'oauth2'` |
