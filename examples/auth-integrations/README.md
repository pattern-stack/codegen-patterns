# auth-integrations starter

Canonical OAuth2 integration storage for apps using the
`@pattern-stack/codegen` auth subsystem (ADR-031 / `runtime/subsystems/auth/`).

The auth subsystem ships the abstract OAuth2 plumbing — `OAuth2RefreshStrategy`,
`AuthController`, `withAuthRetry`, encryption, error types, and a set of narrow
hexagonal ports for integration storage. It deliberately doesn't ship the
concrete `integrations` table or the adapters that satisfy those ports, because
every consumer would need to fork them. **This starter is what plugs that gap.**

## What ships here

```
examples/auth-integrations/
  definitions/
    entities/
      integration.yaml                      # canonical entity (run cdp entity new)

  runtime/integrations/                     # vendored to apps/api/src/shared/integrations/
    integration-reader.adapter.ts           # IIntegrationReader impl
    integration-token-writer.adapter.ts     # IIntegrationTokenWriter impl
    integration-grant-sink.adapter.ts       # IIntegrationGrantSink impl
    integrations-auth.module.ts             # binds the three AUTH_INTEGRATION_* tokens
    integrations.service.ts                 # consumer-facing facade
    use-cases/
      create-or-update-from-oauth-grant.use-case.ts
      mark-integration-requires-reauth.use-case.ts
      disconnect-integration.use-case.ts
      list-user-integrations.use-case.ts
```

## How to install (manual; pending #287)

A future `cdp subsystem install auth-integrations` command will vendor these
files for you. Until then:

1. Install + register the auth subsystem (`AuthModule.forRoot({ ... })`).
2. Copy `definitions/entities/integration.yaml` into your project's
   `definitions/entities/` directory.
3. Run `cdp entity new --all` (or `cdp entity new integration`). This emits
   `apps/api/src/modules/integrations/` (entity, repository, service, module,
   DTOs, use cases).
4. Copy `runtime/integrations/` into `apps/api/src/shared/integrations/`.
5. Import `IntegrationsAuthModule` from
   `apps/api/src/shared/integrations/integrations-auth.module.ts` in your
   `AppModule` (or wherever you compose feature modules). Order it AFTER
   `AuthModule.forRoot(...)` — `IntegrationsAuthModule` depends on the
   `ENCRYPTION_KEY` provider that `AuthModule` registers.

## Two interfaces, two purposes

The auth subsystem requires three narrow ports:

| Token                            | Port                       | Used by                        |
| -------------------------------- | -------------------------- | ------------------------------ |
| `AUTH_INTEGRATION_READER`        | `IIntegrationReader`       | `OAuth2RefreshStrategy.resolve` |
| `AUTH_INTEGRATION_TOKEN_WRITER`  | `IIntegrationTokenWriter`  | `OAuth2RefreshStrategy.resolve` |
| `AUTH_INTEGRATION_GRANT_SINK`    | `IIntegrationGrantSink`    | `AuthController.callback`       |

These stay narrow on purpose — a non-codegen consumer with a hand-rolled
integrations table can satisfy them without pulling in the rest of this
starter.

The starter's `IntegrationsService` is **a separate, richer interface** that
your app code (controllers, handlers, frontend-facing routes) talks to
directly. It composes the use cases, applies encryption, and exposes
consumer-shaped methods like `findByUserAndProvider`, `listByUser`,
`createOrUpdateFromOAuthGrant`, `markRequiresReauth`, and `disconnect`.

Same precedent as EAV: `FieldValueService.upsertFieldsTransactional` is
wider than `IFieldValueRepository.upsertCurrentValues`.

## `scopes` is `json`, not `string_array`

This is deliberate. The codegen `string_array` field type currently emits
`z.unknown()` in generated DTOs (open bug #281). Storing as `json` keeps the
column shape correct (`jsonb` holding `string[]`) without DTO regressions.
Once #281 lands, the field can be re-typed to `string_array` without behavior
change.

**Do not "clean up" to `string_array` until #281 ships.**

## `provider` is `string`, not `enum`

Adding a new provider (`google`, `gusto`, …) should be a code change (a new
`IProviderStrategy` registered in `STRATEGY_REGISTRY`), not a YAML/migration
change. The string column matches the strategy registry's key type and
supports any provider slug your app cares about.

## Smoke checklist

After install:

- [ ] `IntegrationsService.findByUserAndProvider(userId, 'hubspot-crm')`
      returns `null` for missing rows, decrypted-creds for present rows.
- [ ] `createOrUpdateFromOAuthGrant({ userId, provider, accessToken, ... })`
      upserts on `(user_id, provider)`. Re-running with a different access
      token replaces the prior token; omitting `refreshToken` keeps the
      existing ciphertext.
- [ ] `markRequiresReauth(integrationId)` flips status to `requires_reauth`.
- [ ] `disconnect(integrationId)` flips status to `revoked` and clears the
      stored ciphertexts.
- [ ] `OAuth2RefreshStrategy.resolve()` end-to-end refresh works against a
      provider-strategy you've registered (out of scope — provider strategies
      are consumer-side per ADR-031).

## Related

- ADR-031 — auth subsystem (Accepted)
- #285 — this starter (tracking issue)
- #286 — `AuthController` + integration-store ports (merged in PR #289)
- #287 — `cdp subsystem install auth-integrations` template (follow-up)
