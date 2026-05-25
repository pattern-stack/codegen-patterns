# ADR-0002 — RequesterContext boundary (auth → ambient scope)

- **Status:** Accepted
- **Date:** 2026-05-25
- **Builds on:** [ADR-0001](./0001-ambient-tenant-scoping.md)
- **Affects:** `runtime/subsystems/auth/protocols/user-context.ts`, new `runtime/subsystems/auth/middleware/requester-context.ts`, `src/cli/shared/init-scaffold.ts`

## Context

ADR-0001 made `BaseRepository` scope reads/writes by the **ambient**
`RequesterContext`, but left the boundary install as a deferral: nothing actually
*sets* that context on an HTTP request. So a Swagger-driven call (the generated
controllers already carry `@ApiBearerAuth()`, so the "Authorize" button injects a
bearer header) reached the repo with no context — unscoped in lenient mode, or a
`No requester context active` throw in strict mode. This ADR closes the loop.

The auth subsystem already ships the seam: `IUserContext.getCurrentUserId(req)`
(consumer-bound under `AUTH_USER_CONTEXT`), documented to decode exactly that
bearer header. What was missing was the piece that runs `withRequester(...)`
around the request using it.

## Decision

1. **`IUserContext.resolveRequester?(req): Promise<RequesterContext>`** — optional.
   When implemented, it supplies the full `org`/`superuser` context; when absent,
   the boundary derives plain `'user'` scope from `getCurrentUserId`. Backward
   compatible — existing `IUserContext` impls keep working untouched.

2. **`makeRequesterContextMiddleware(userContext, opts)`** (Express-style) — resolves
   the requester, then runs the rest of the pipeline inside `withRequester(ctx, …)`.
   ALS correctness: `als.run` invokes its callback synchronously and Express
   dispatches downstream inside `next()`, so all handlers (and their awaits)
   inherit the context. Implemented as **middleware, not an interceptor** —
   interceptors returning an Observable do not preserve ALS cleanly.

3. **`installRequesterContext(app)`** — the one-liner consumers add to `main.ts`.
   Resolves `AUTH_USER_CONTEXT` from the **root container** (`app.get(token,
   { strict: false })`) so it sees the consumer's AppModule binding — sidestepping
   the module-scoping problem (the token is provided in AppModule, not AuthModule).
   No-ops with a warning when the token is unbound, so the call is safe even before
   auth is wired.

4. **`persistAuthorization: true`** on the generated `main.ts` `SwaggerModule.setup`
   — the "Authorize" bearer token survives reloads, so it keeps flowing as the
   `Authorization` header that the boundary turns into scope.

## Trust + failure model

- The boundary **trusts** what `IUserContext` returns — authn (validating the
  token) and authz (which scope a requester may claim) live in the impl, exactly
  as for a hand-threaded `userId`.
- Unresolved requester (no/invalid credentials — public routes, the OAuth callback
  itself) → proceed **unscoped** (`onUnresolved: 'unscoped'`, default). Lenient
  repos run unscoped; strict repos throw downstream (correct — unauthenticated
  callers must not reach scoped data). `onUnresolved: 'reject'` fails at the
  boundary instead.

## Why a one-liner, not auto-wired into the default scaffold

The generated default `main.ts` must compile for scaffolds that never install the
auth subsystem, so it cannot statically `import` an auth-subsystem path. The
install is therefore a documented one-liner (shipped + tested helper) plus a
commented hint in the generated `main.ts`. Auto-patching `main.ts` at
`subsystem install auth` time (as Swagger is patched via `ast-patch`) is the
natural follow-up.

## Deferred

- `subsystem install auth` auto-patching the `installRequesterContext(app)` call
  into an existing `main.ts` (ast-patch), mirroring the Swagger block.
- A tRPC equivalent middleware (dealbrain's original boundary), for consumers
  exposing tRPC instead of / alongside REST.
- Junction-repo scoping (carried over from ADR-0001).
