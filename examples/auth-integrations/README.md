# auth-integrations starter

Canonical OAuth2 connection storage for apps using the
`@pattern-stack/codegen` auth subsystem (ADR-031 / `runtime/subsystems/auth/`).

The auth subsystem ships the abstract OAuth2 plumbing — `OAuth2RefreshStrategy`,
`AuthController`, `withAuthRetry`, encryption, error types, and a set of narrow
hexagonal ports for connection storage. It deliberately doesn't ship the
concrete `connections` table or the adapters that satisfy those ports, because
every consumer would need to fork them. **This starter is what plugs that gap.**

## What ships here

```
examples/auth-integrations/
  definitions/
    entities/
      connection.yaml                      # canonical entity (run cdp entity new)

  runtime/connections/                     # vendored next to the codegen-emitted
                                            #   connection entity module — i.e.
                                            #   <backend_src>/modules/connections/
                                            #   (override via paths.modules_dir).
    adapters/
      connection-reader.adapter.ts         # IConnectionReader impl
      connection-token-writer.adapter.ts   # IConnectionTokenWriter impl
      connection-grant-sink.adapter.ts     # IConnectionGrantSink impl
    facade/
      connections.service.ts               # consumer-facing facade
    oauth/
      use-cases/
        create-or-update-from-oauth-grant.use-case.ts
        mark-connection-requires-reauth.use-case.ts
        disconnect-connection.use-case.ts
        list-user-connections.use-case.ts
    connections-auth.module.ts             # @Global() — binds the three
                                            #   AUTH_CONNECTION_* tokens.
```

## How to install

```bash
cdp subsystem install auth          # one-time: vendor the auth subsystem
cdp subsystem install auth-integrations
cdp entity new connection          # emits the entity module next to the vendor
```

The `auth-integrations` install:
- copies `definitions/entities/connection.yaml` into your configured
  `paths.entities` (or legacy `paths.entities_dir`) directory.
- vendors `runtime/connections/**` under
  `<backend_src>/modules/connections/` (override via `paths.modules_dir`),
  rewriting bare `@pattern-stack/codegen/runtime/subsystems/auth` imports to
  relative paths that resolve against the vendored auth subsystem at
  `<paths.subsystems>/auth`.
- appends a TODO to `<backend_src>/app.module.ts` reminding you to register
  `ConnectionsAuthModule` AFTER `AuthModule.forRoot(...)`.

`ConnectionsAuthModule` is `@Global()` because `AuthController` (inside
`AuthModule`'s injector) resolves the `AUTH_CONNECTION_*` providers exposed
by it.

## Two interfaces, two purposes

The auth subsystem requires three narrow ports:

| Token                            | Port                       | Used by                        |
| -------------------------------- | -------------------------- | ------------------------------ |
| `AUTH_CONNECTION_READER`        | `IConnectionReader`       | `OAuth2RefreshStrategy.resolve` |
| `AUTH_CONNECTION_TOKEN_WRITER`  | `IConnectionTokenWriter`  | `OAuth2RefreshStrategy.resolve` |
| `AUTH_CONNECTION_GRANT_SINK`    | `IConnectionGrantSink`    | `AuthController.callback`       |

These stay narrow on purpose — a non-codegen consumer with a hand-rolled
connections table can satisfy them without pulling in the rest of this
starter.

The starter's `ConnectionsService` is **a separate, richer interface** that
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

- [ ] `ConnectionsService.findByUserAndProvider(userId, 'hubspot-crm')`
      returns `null` for missing rows, decrypted-creds for present rows.
- [ ] `createOrUpdateFromOAuthGrant({ userId, provider, accessToken, ... })`
      upserts on `(user_id, provider)`. Re-running with a different access
      token replaces the prior token; omitting `refreshToken` keeps the
      existing ciphertext.
- [ ] `markRequiresReauth(connectionId)` flips status to `requires_reauth`.
- [ ] `disconnect(connectionId)` flips status to `revoked` and clears the
      stored ciphertexts.
- [ ] `OAuth2RefreshStrategy.resolve()` end-to-end refresh works against a
      provider-strategy you've registered (out of scope — provider strategies
      are consumer-side per ADR-031).

## Related

- ADR-031 — auth subsystem (Accepted)
- #285 — this starter (tracking issue)
- #286 — `AuthController` + connection-store ports (merged in PR #289)
- #287 — `cdp subsystem install auth-integrations` template (follow-up)
