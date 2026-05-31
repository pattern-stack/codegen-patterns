# ADR-031 — Auth subsystem: OAuth2 refresh template-method + encryption-at-rest port

**Status:** Accepted
**Date:** 2026-04-20
**Owner:** Doug
**Related:** ADR-001 (hexagonal), ADR-008 (subsystem architecture), issue [#59](https://github.com/pattern-stack/codegen-patterns/issues/59)

> **Vocabulary note (2026-05-30, ADR-0005):** This ADR predates the vendor-link rename (shipped in 0.11.0). The narrow storage ports `IIntegrationReader` / `IIntegrationTokenWriter` (and `IIntegrationGrantSink`), the `DecryptedIntegration` type, and the `AUTH_INTEGRATION_*` DI tokens named below are now `IConnectionReader` / `IConnectionTokenWriter` / `IConnectionGrantSink`, `DecryptedConnection`, and `AUTH_CONNECTION_*` (the vendor-link entity is `connection`, FK `connection_id`). The OAuth2 refresh template-method design is unchanged. See swe-brain `ADR-0005-rename-sync-to-integration` and the 0.11.0 CHANGELOG.

## Context

Every external integration an app builds — Salesforce, HubSpot, Gmail, Slack,
Gong — repeats the same auth loop:

1. Resolve credentials for an integration row.
2. If the access token is missing/expired, POST `grant_type=refresh_token` to
   the provider's token endpoint.
3. Persist the new access token (and possibly a rotated refresh token) at
   rest, encrypted.
4. Catch "session expired" from the vendor SDK, retry once with a fresh token.
5. On 400 `invalid_grant`/`invalid_token`, mark the integration broken so
   background work stops attempting to use it.

What varies per provider: the token endpoint URL, the body parameters, the
field names in the refresh response, the credentials shape (SFDC ships an
`instance_url`; HubSpot doesn't). What's identical: everything else —
expiry-window math, force-refresh semantics, form-urlencoded POST, error
mapping, rotation handling, encryption, state-parameter CSRF protection.

The dealbrain-v2 project built this auth layer from scratch for Salesforce,
then validated the shape by shipping HubSpot as a second consumer
(Gate-1 "build first, extract later"). The findings doc captures the
details: four small hooks per subclass, zero base-class changes needed
across the two providers.

This ADR captures the upstream extraction of that work into the
codegen-patterns `runtime/subsystems/auth/` tree.

## Decision

### Slot under ADR-008's Protocol → Backend → Factory

The auth subsystem follows the same three-layer pattern as events / jobs /
cache / storage:

- **Protocols** (`protocols/`) — `IAuthStrategy`, `IEncryptionKey`,
  `IOAuthStateStore`, plus the narrow storage ports `IIntegrationReader` +
  `IIntegrationTokenWriter` that let the refresh flow talk to the consumer's
  integrations table without importing any entity framework.
- **Runtime** (`runtime/`) — `OAuth2RefreshStrategy` (abstract template-
  method base), `withAuthRetry`, `SessionExpiredError` marker,
  `IntegrationBrokenError`.
- **Backends** (`backends/`) — `EnvEncryptionKey` (AES-256-GCM from env) +
  `InMemoryOAuthStateStore` (dev). Future: KMS-backed encryption, Redis-
  backed state store.
- **Factory** (`auth.module.ts`) — `AuthModule.forRoot({ encryptionKey,
  oauthStateStore })` binds the backends; `global: true` so consumer modules
  don't re-import.

### Template-method contract (four hooks, two constants)

`OAuth2RefreshStrategy.resolve()` is concrete. Subclasses override:

```ts
protected abstract readonly provider: string;              // slug
protected abstract readonly defaultExpiresInSec: number;   // response fallback

protected abstract tokenEndpoint(): string;
protected abstract refreshBodyExtras(): Record<string, string>;
protected abstract parseRefreshResponse(raw: unknown): ParsedRefreshResponse;
protected abstract buildCredentials(
  accessToken: string,
  integration: DecryptedIntegration,
  refreshRaw?: unknown,
): AuthCredentials;
```

Base class handles (zero subclass intervention):
- 5-minute expiry safety window
- `forceRefresh` escape hatch
- `no_refresh_token` → `IntegrationBrokenError`
- Form-urlencoded POST with `Content-Type: application/x-www-form-urlencoded`
- 400 `invalid_grant`/`invalid_token` → `IntegrationBrokenError`
- Non-2xx → generic error with provider-scoped message
- Refresh-token rotation persistence
- Fetch + clock injection for tests
- Provider-slug mismatch check

Gate-1 evidence: four hooks + two constants are sufficient for both
Salesforce (which rotates refresh tokens sometimes and ships `instance_url`)
and HubSpot (which rotates every time, ships no host, needs `redirect_uri`
in the refresh body). No base-class changes were needed when HubSpot landed.

### `buildCredentials(…, refreshRaw?)` — opaque raw passthrough

The raw refresh response is passed through to the subclass as a third
argument. Salesforce peeks for a refreshed `instance_url`; HubSpot ignores
it. The base class treats the raw response as opaque — it never inspects
fields beyond the `ParsedRefreshResponse` the subclass returns.

This keeps the contract narrow. Adding a fifth hook for every new per-
provider concern would force the base class to know about each field;
passing the raw response gives subclasses full escape-hatch flexibility
without widening the hook surface.

### `SessionExpiredError` marker + `isSessionExpiredError` predicate

Dealbrain's original `withAuthRetry` hardcoded `instanceof
SalesforceSessionExpiredError`. Upstream replaces that with a
duck-typed marker — any error that is `instanceof SessionExpiredError` OR
carries `isSessionExpired === true` gets retried. Provider error classes
join the contract without extending this subsystem's class hierarchy,
which avoids the cross-package `instanceof` footgun.

`withAuthRetry` also takes an optional `isSessionExpired` classifier for
consumers who want a custom predicate.

### Narrow integration-store ports (no entity framework dep)

`OAuth2RefreshStrategy` needs to read decrypted integration rows and
persist refreshed tokens. The subsystem cannot import the consumer's
`IntegrationService` — that would couple it to a specific entity
framework.

Solution: two narrow ports.

```ts
interface IIntegrationReader {
  findByIdDecrypted(integrationId: string): Promise<DecryptedIntegration | null>;
}

interface IIntegrationTokenWriter {
  persistRefresh(update: IntegrationTokenUpdate): Promise<void>;
}
```

Consumers implement these as thin adapters over whatever service they've
generated. The planned `examples/auth-integrations/integration.yaml`
starter (separate PR) ships canonical implementations out of the box.

### What the subsystem does NOT wire

- **`IAuthStrategy` implementations.** Every app has multiple concurrent
  strategies (one per provider). Registration belongs in the provider
  module (`SalesforceModule`, `HubSpotModule`), not the subsystem. There
  is no single `AUTH_STRATEGY` token.
- **Integration-store ports.** They're inherently consumer-specific —
  the subsystem ships the ports; the app's integrations domain satisfies
  them. Wiring happens in the module that owns the integrations entity.

## Consequences

### Positive

- **Two providers de-risk the abstraction.** SFDC and HubSpot share a
  non-trivial contract without any base-class compromises.
- **Tests don't need a real provider.** A 50-line fake subclass exercises
  every hook. Backend unit tests skip Docker entirely (env key roundtrip +
  in-memory state store).
- **Consumers stay decoupled from entity framework.** The narrow integration
  ports mean any app can adopt the subsystem without committing to
  codegen-patterns' entity model.
- **Future providers (Gmail, Slack) fit without code changes.** If they
  don't, it's a bug that the two-consumer Gate-1 missed — not an expected
  evolution.

### Negative

- **`AuthModule.forRoot` is thinner than events/cache.** It wires only two
  of the four tokens (encryption + state store); integration-store tokens
  + `IAuthStrategy` instances stay in consumer modules. This is correct —
  those bindings ARE consumer-specific — but it means the subsystem doesn't
  give the same "one-line install" feel.
- **Error taxonomy is shallow.** `IntegrationBrokenError` + `SessionExpiredError`
  cover the two cases all known providers need. A future provider with a
  richer error model may need additional error types.

### Neutral

- Third consumer (Gmail, Slack) is the real test of whether four hooks
  are enough. Plan: ship Gmail on top of `OAuth2RefreshStrategy` in a
  future dealbrain-v2 PR; if a fifth hook is needed, revise this ADR.
- PKCE support is explicitly out of scope for the initial extraction.
  Adding PKCE is additive (another subclass hook or a new strategy
  type); the existing refresh-token flow is orthogonal.

## Alternatives Considered

### Hardcode OAuth2 refresh into every provider module

Status quo before Gate-1. Each provider reimplements the same 120-line
refresh flow. Rejected: the duplication is mechanical, and bugs found in
one copy (e.g. safe-JSON parsing on error responses) have to be fixed
N times.

### Single-consumer extraction (just Salesforce)

What we rejected at Gate-1. The findings doc makes the explicit case:
one consumer's abstraction is overfit by construction. HubSpot forced
the `refreshBodyExtras()` hook into existence.

### Wire `IAuthStrategy` centrally via a registry

Every provider module registers its strategy at a central
`AUTH_STRATEGIES` map. Rejected: it adds indirection for no win —
consumers inject `SALESFORCE_AUTH_STRATEGY` directly in the SFDC adapter
today; the registry would just rename that token without changing what
the adapter looks up.

## References

- [Gate-1 auth extraction findings](https://github.com/pattern-stack/dealbrain/blob/main/docs/gate-1-auth-extraction-findings.md) — the upstream PR body cites this doc (also copied into the PR for reference).
- [ADR-008 — Subsystem architecture](./ADR-008-subsystem-architecture.md)
- [Issue #59 — Add auth subsystem](https://github.com/pattern-stack/codegen-patterns/issues/59)
