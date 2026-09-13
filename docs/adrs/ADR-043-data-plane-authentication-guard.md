# ADR-043 — Closed-by-Default Data-Plane Authentication (global guard, ALS-derived actor, fail-loud-when-unbound)

**Status:** Proposed
**Date:** 2026-06-22
**Owner:** Doug
**Related:** ADR-001 (DDD + hexagonal — the controller/use-case/repository layering this guards), ADR-005 (entity-family base classes), ADR-008 (subsystem Protocol→Backend→Factory pattern — the auth subsystem this extends), ADR-042 (automatic repository-level tenant scoping — this ADR makes 042's ambient actor *trustworthy*; 042 scopes by an actor, this one proves the actor is real), `ai-docs/adrs/0002-requester-context-boundary` (the `installRequesterContext` boundary this completes the auto-wiring of), GitHub #557 (the security finding this answers), #556 (frontend-exclude knob — the frontend analogue of the per-entity `api:false` in §6)

> **Sequencing note.** This ADR settles *authentication* — "is there a verified principal on this request at all." It is the missing first half of the trust chain whose second half (ADR-042) settles *isolation* — "which rows may that principal touch." 042 is safe to ship before this only under `scopeEnforcement: 'lenient'` on a trusted boundary; under any real deployment the two land together, because scoping by a **self-asserted** actor (today's `x-user-id` header) is isolation theater. The machinery this ADR needs already exists — the `RequesterContext` ALS, the `installRequesterContext` boundary middleware, the `IUserContext` port. What is missing is *enforcement* (a request with no resolvable principal is currently served, not rejected) and *wiring* (the boundary is a commented hint in `main.ts`, not auto-installed). This ADR adds both.

## Context

The generated data plane ships **unauthenticated**. Surfaced during a security audit of a consumer (swe-brain @ codegen 0.28.3), GitHub #557:

- **No global guard.** There is no `APP_GUARD`, no `useGlobalGuards`, nowhere in the generated `main.ts` (`src/cli/shared/init-scaffold.ts:355`, the default bootstrap) that rejects an unauthenticated request. Every `/<plural>` route is reachable with no bearer token.
- **The actor is self-asserted.** Both backend controller pipelines derive the acting principal from **client-supplied headers**: clean-lite-ps `templates/entity/new/clean-lite-ps/controller.ejs.t` and clean `templates/entity/new/backend/presentation/controller.ejs.t` both read `@Headers('x-user-id')` / `@Headers('x-tenant-id')` and pass `{ actor: { userId, tenantId } }` into the use-case. An anonymous caller picks their own `userId` — and then ADR-042 would dutifully "isolate" to whatever tenant they typed.
- **The protection that exists guards the wrong surface.** The hand-rolled `/auth/session/*` controller injects `AUTH_USER_CONTEXT`, and the app's verification-gates-login posture protects *that* surface — but not the generated CRUD. The session controller is a fence around the gate while the data plane has no fence at all.

The dangerous part is that **the actor-derivation and row-scoping machinery is already complete and correct** — which makes the hole easy to miss. Three concerns have been conflated:

1. **Authentication** — *is there a verified principal on this request?* **This does not exist.** Nothing rejects a principal-less request.
2. **Actor derivation** — *who is the principal?* Solved, twice over: the *correct* path is `IUserContext.resolveRequester(req)` (the consumer's JWT/session verification) feeding the ALS; the *dangerous* path is the `x-*` headers. Both are live; the headers are dead weight that only a missing guard makes exploitable.
3. **Row scoping** — *which rows may the principal touch?* Solved by `BaseRepository.scopePredicate()` (`runtime/base-classes/base-repository.ts:273-292`) reading the ambient `RequesterContext`, and extended per-tenant by ADR-042.

The floor for closing #557 is already in place:

- **A proven ambient context + boundary.** `RequesterContext` + `withRequester` / `requireRequester` / `tryGetRequester` (`runtime/base-classes/tenant-context.ts:64-127`) carry the principal through every `await`. The boundary that seeds it from a verified request — `installRequesterContext(app)` reading the consumer-bound `IUserContext` and running the request inside `withRequester(...)` — is built and tested (`runtime/subsystems/auth/middleware/requester-context.ts:124-141`).
- **A universal port for verification.** `IUserContext.resolveRequester(req)` / `getCurrentUserId(req)` (`runtime/subsystems/auth/protocols/user-context.ts:22-39`) is exactly where token verification lives — the consumer's job, app-specific, but the contract ships.
- **An AST-patch toolkit for `main.ts`.** `ensureMainSwaggerBlock` + `ensureImport` + `ensureModuleImportEntry` (`src/cli/shared/ast-patch.ts:55,172,271`) already patch a consumer's bootstrap; the OpenAPI upgrade command (`src/cli/commands/project-upgrade-openapi.ts`) is the live precedent for patching `main.ts` + `app.module.ts` at subsystem-install time. ADR-0002 explicitly named this auto-patch as the deferred follow-up for `installRequesterContext`.

What is missing is **enforcement** (reject a request with no resolvable principal), the **deletion of the self-asserted header path**, **per-entity route suppression** for secret entities, and the **auto-wiring** that turns the boundary from a commented hint into a guarantee. This ADR adds all four.

## Decision

Adopt **closed-by-default data-plane authentication**: a global guard rejects any request that has no ambient `RequesterContext`, the verified actor comes exclusively from `IUserContext` via the ALS (never from headers), and a generated app that exposes entity HTTP controllers with **no `IUserContext` bound fails loud at boot** rather than serving an open data plane.

### 1. Division of labor — middleware *establishes*, guard *enforces*

The two layers stay separate, each doing the one thing it is positioned to do:

- **The boundary middleware (unchanged)** — `installRequesterContext(app)` resolves the requester via `IUserContext` and runs the rest of the request inside `withRequester(ctx, ...)`. It **never rejects** (`onUnresolved: 'unscoped'` stays the default): its sole job is to *establish* ambient context when one is resolvable. It runs *before* routing, so it cannot see which handler will run or what decorators it carries.
- **A new global guard (`APP_GUARD`)** — runs *after* routing, sees route metadata via the NestJS `Reflector`, and *enforces*: if the matched handler is not `@Public()` and `tryGetRequester()` returns no context, it throws `UnauthorizedException` (401).

**Why a guard and not just `onUnresolved: 'reject'` in the middleware.** The middleware already has a `'reject'` mode (`requester-context.ts:60-62`). It is the wrong tool for enforcement because Express middleware runs before NestJS routing — it has no `Reflector`, no handler reference, no `@Public()` visibility. Its only opt-out is brittle path-string matching against the OAuth callback and `/auth/session/*` routes (which *must* be reachable unauthenticated — they are how you obtain a token in the first place). A guard reads `@Public()` off the exact handler. So: middleware bridges, guard decides. Each layer touches the concern it can actually see.

### 2. The guard, the decorator, the binding

The guard reads the ambient context the middleware established — it does **not** re-resolve the principal (single source of truth: the ALS):

```ts
// runtime/subsystems/auth/guards/authenticated.guard.ts  (new, ships with the auth subsystem)
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tryGetRequester } from '../../../base-classes/tenant-context';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class AuthenticatedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    // The boundary middleware ran withRequester(...) iff IUserContext resolved a
    // verified principal. No context here == no authenticated principal.
    if (tryGetRequester()) return true;
    throw new UnauthorizedException();
  }
}
```

```ts
// runtime/subsystems/auth/guards/public.decorator.ts  (new)
import { SetMetadata } from '@nestjs/common';
export const IS_PUBLIC_KEY = 'auth:isPublic';
/** Opt a route OUT of the global AuthenticatedGuard. Use sparingly. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

The binding is an `APP_GUARD` provider registered by `AuthModule.forRoot(...)`, so installing the auth subsystem wires the guard globally with **no per-controller change and no opt-out except `@Public()`**:

```ts
// inside AuthModule.forRoot's providers:
{ provide: APP_GUARD, useClass: AuthenticatedGuard },
```

There is deliberately no config knob to disable the guard while auth is installed. Install auth ⇒ enforced. The only route-level escape is the explicit, greppable `@Public()` decorator.

> **Self-lockout is a ship-blocker, not friction.** The moment the guard binds, any route you call to *obtain* a credential requires a credential unless it carries `@Public()` — a hard chicken-and-egg lockout, not a degraded experience. Two populations of such routes, with different ownership:
>
> - **Package-shipped (this PR's hand-edit):** the subsystem's `AuthController` (`runtime/subsystems/auth/controllers/auth.controller.ts`) ships exactly two routes — `GET :provider/connect` and `GET :provider/callback`. Only the **callback** must be `@Public()`: the provider redirects the browser there with no app session, and the caller's identity is carried in the signed `state`. **`connect` deliberately stays guarded** — starting a connect flow requires an already-authenticated user (it calls `getCurrentUserId(req)`), and the guard now enforces what that call previously assumed. So the package hand-edit is a single `@Public()` on `callback`.
> - **Consumer-side (not this repo):** a consumer's own session controller — swe-brain's `/auth/session/login` / `register` / `resend-verification` — must carry `@Public()` too, but those controllers live in the consumer tree, so that annotation is part of the consumer adoption lane, not this PR.
>
> Landing `@Public()` on the package `callback` (with a test asserting it is reachable unauthenticated) is an acceptance criterion of the guard PR, not a later cleanup — see follow-up #1.

### 3. Gate on `IUserContext` binding — not on *our* subsystem

The guard's posture keys on **whether any `IUserContext` is bound** under `AUTH_USER_CONTEXT`, regardless of whether the binding came from our auth subsystem or a consumer's own JWT/session adapter. This respects bring-your-own-auth without forcing our subsystem, while still closing the hole for the forgetful adopter:

- **Install our auth subsystem** → `IUserContext` bound by `AuthModule` → guard enforced. **Mandatory; no bypass.**
- **Bring your own auth** → consumer binds their own `IUserContext` under `AUTH_USER_CONTEXT` → guard enforced against it.
- **Bind nothing, but emit entity HTTP controllers** → **fail loud at boot** (see §4).

This is the explicit replacement for the rejected compromise "no auth installed ⇒ data plane silently open." That compromise protected the non-adopter at the cost of correctness. The gate-on-binding rule protects the *adopter who forgot*, costs the non-adopter nothing they didn't opt into, and never forces our specific subsystem on anyone.

### 4. Fail loud when an HTTP data plane has no `IUserContext`

A generated app that exposes entity HTTP controllers but binds no `IUserContext` is the silent-open footgun. We make "open data plane" a **deliberate, loud, opt-in** instead of the default. At bootstrap, after `NestFactory.create` and after the (auto-wired) `installRequesterContext(app)`:

```ts
// emitted into the bootstrap guard block (see §7), pseudo-shape:
const userContext = app.get(AUTH_USER_CONTEXT, { strict: false });
const allowAnonymous = config.auth?.devAllowAnonymous === true;
if (!userContext && !allowAnonymous) {
  throw new Error(
    '[auth] FATAL: entity HTTP controllers are exposed but no IUserContext is ' +
      'bound under AUTH_USER_CONTEXT. The data plane would be unauthenticated. ' +
      'Bind an IUserContext (install the auth subsystem, or provide your own), ' +
      'or set auth.devAllowAnonymous=true for LOCALHOST DEV ONLY.',
  );
}
if (!userContext && allowAnonymous) {
  console.warn(
    '[auth] auth.devAllowAnonymous=true — data plane is UNAUTHENTICATED. ' +
      'This must never be set in a non-localhost deployment.',
  );
}
```

`auth.devAllowAnonymous` is the single, obviously-named, loud escape hatch for localhost dev and the smoke harness. It is documented as never-for-prod; a future hardening can additionally refuse it when the bind address is non-loopback or `NODE_ENV==='production'`. The point: the *only* way to ship an open data plane is to type a flag whose name says you shouldn't.

> **Boot-fail scope — discriminate the HTTP process, not the module graph.** The check fires only for a process that actually *serves* the data plane. Detection must gate on "this process calls `app.listen()`," **not** "this module graph contains entity controllers" — emit the guard block into the **HTTP entrypoint's bootstrap (`main.ts`) only, never `worker.ts`**. This is load-bearing for the split-process consumer: swe-brain's `worker.ts` imports `AppModule` *whole* (controllers and all) but never listens on a port — gating on controller *presence* would false-trip the worker into a boot-fail with no data plane to protect. A library-only or worker-only scaffold has no `main.ts` HTTP bootstrap and so never reaches the check.

### 5. Delete the self-asserted header path; the actor comes from the ALS

Both controller pipelines drop the `@Headers('x-user-id')` / `@Headers('x-tenant-id')` parameters and the `{ actor: { userId, tenantId } }` threading entirely. The acting principal is whatever the verified `IUserContext` established in the ALS — nothing the client can assert.

**clean-lite-ps** (`templates/entity/new/clean-lite-ps/controller.ejs.t`) and **clean** (`templates/entity/new/backend/presentation/controller.ejs.t`) lose the header params on `create` / `update` / `delete`:

```diff
   @Post()
   async create(
     @Body(new ZodValidationPipe(<%= classNames.createSchema %>)) dto: <%= classNames.createDto %>,
-    @Headers('x-tenant-id') tenantId?: string,
-    @Headers('x-user-id') userId?: string,
   ): Promise<<%= classNames.entity %>> {
-    return this.createUseCase.execute(dto, { actor: { tenantId, userId } });
+    return this.createUseCase.execute(dto);
   }
```

Use-cases that need the actor (e.g. stamping `created_by` via the `userTracking` behavior) read it from the ambient context — `requireRequester()` under strict, `tryGetRequester()` under lenient — exactly as `BaseRepository.scopePredicate()` and ADR-042's `tenantPredicate()` already do. This deletes the actor-threading from the controller→use-case signature rather than re-sourcing it: the ambient context is the single, verified source, consistent with ADR-042's whole "no signature pollution" thesis. The `@ApiBearerAuth()` decorator on the controllers stays — it now matches reality (the route genuinely requires a bearer token, enforced by the guard).

> **No backwards compat (per CLAUDE.md).** The `x-*` header path is not deprecated-and-kept; it is deleted. It existed only as a pre-ALS actor source and is now a security liability with a superior replacement. There is no opt-in to bring it back.

### 6. Per-entity `api: false` — don't emit HTTP routes for secret entities

Proposal #3 of #557, folded in: some entities (credentials, internal join tables, secret material) should not have an HTTP surface at all, rather than having one that is merely guarded. Consumers currently hand-block these in `main.ts`. Add a per-entity opt-out that suppresses controller + route emission entirely.

Add to `EntityDefinitionSchema` (`src/schema/entity-definition.schema.ts`, alongside the existing top-level entity flags):

```ts
// HTTP surface emission (ADR-043, #557). When false, codegen emits NO
// controller and NO routes for this entity — the entity, repository, service,
// and use-cases are still generated (it remains reachable in-process), but it
// has no data-plane presence. Defaults to true. The backend analogue of the
// frontend-exclude knob (#556).
api: z.boolean().optional().default(true),
```

When `api: false`:

- The controller template (`controller.ejs.t` in both pipelines) and the NestJS route registration are skipped — the `entity new` post-step gates the controller emission on `api !== false`.
- The module still binds the service/use-cases (in-process reachability is unchanged); only the `@Controller` and its routes are absent.
- This is route *emission*, not auth — an `api: false` entity is invisible to HTTP regardless of guard state, which is the correct posture for material that should never traverse the data plane. It composes with §1–§4: a secret entity has no route to guard, and a guarded route is the floor for everything that does emit.

### 7. Auto-wire the boundary + guard at install (complete ADR-0002's deferral)

ADR-0002 shipped `installRequesterContext` as a tested helper plus a **commented hint** in the generated `main.ts`, explicitly deferring the auto-patch. This ADR completes it, using the existing AST-patch toolkit (the OpenAPI command is the precedent). Two surfaces, with the ownership split resolved during implementation:

- **The default scaffold `main.ts`** (`init-scaffold.ts`, `mainTsContent`) wires the live `installRequesterContext(app)` call + the §4 boot-fail block — **but only in `package` mode**, where the auth barrel always resolves from the published package (`@pattern-stack/codegen/subsystems`). In `vendored` mode a bare scaffold has no `./shared/subsystems/auth` until `subsystem install auth` vendors it, so emitting a static import there would dangle on a fresh project; the scaffold instead emits a deferral hint pointing at `project upgrade-auth`. (Resolved during implementation: this is why the wiring is mode-conditional, not unconditional as the first draft assumed.)
- **`project upgrade-auth`** (new command, sibling of `project upgrade-openapi`; `src/cli/commands/project-upgrade-auth.ts`) is the deliberate codemod that wires an existing/vendored consumer:
  - `ensureMainRequesterContextBlock` (new, `ast-patch.ts`) inserts `installRequesterContext(app);` + a self-contained §4 boot-fail block after `NestFactory.create(...)`, plus the auth import. Idempotent (skips if `installRequesterContext(` is present).
  - `ensureModuleDynamicImportEntry` (new, `ast-patch.ts`) inserts `AuthModule.forRoot({...})` into `AppModule.imports` — where the `APP_GUARD` provider from §2 is registered. Matches idempotently by the leading identifier (`AuthModule`) since the entry is a call expression, not a bare identifier.
- **`subsystem install auth` stays TODO-only** (it vendors the auth runtime + appends a hint now pointing at `project upgrade-auth`). Resolved during implementation: auto-constructing `AuthModule.forRoot` *at install* would force its `EnvEncryptionKey` dependency (which throws when `INTEGRATION_TOKEN_ENCRYPTION_KEY` is unset) into **every** `app.init()` — breaking tooling that boots `AppModule` without that env (e.g. the OpenAPI doc-generation smoke). Wiring is therefore the explicit `project upgrade-auth` step, not a silent install side effect. This mirrors the existing OpenAPI split (`subsystem install openapi-config` adds config; `project upgrade-openapi` does the AST wiring).

**Barrel-export prerequisite (resolved in this PR).** The generated `main.ts` (package mode) imports `installRequesterContext` + `AUTH_USER_CONTEXT`, and `project upgrade-auth` imports `AuthModule`, from the **curated** `@pattern-stack/codegen/subsystems` barrel (`runtime/subsystems/index.ts`). That barrel previously re-exported the auth tokens / `AuthModule` / `AuthController` but **not** the middleware, guard, or decorator. PR2 adds `installRequesterContext`, `makeRequesterContextMiddleware`, `resolveRequesterContext`, `AuthenticatedGuard`, `Public`, and `IS_PUBLIC_KEY` to the combined barrel (a regression test asserts their presence) — without it the auto-wired `main.ts` would fail to resolve in package mode.

This is the difference between "the boundary exists and you must remember to call it" and "the boundary is wired by one explicit, idempotent command." #557 exists precisely because remembering was optional; `project upgrade-auth` makes wiring a single deterministic step, and the package-mode scaffold is closed-by-default out of the box.

## Consequences

**Positive.**

- **Closed-by-default data plane.** Once an `IUserContext` is bound, every entity route requires a verified principal; the only exception is an explicit, greppable `@Public()`. The #557 hole — anonymous read of every entity and anonymous `POST`/`PATCH`/`DELETE` — is closed by a single global guard.
- **The actor is no longer self-asserted.** Deleting the `x-*` header path means the principal ADR-042 scopes by is the one `IUserContext` *verified*, not the one the client *typed*. This is what makes 042's isolation real rather than theater.
- **No silent-open state.** An HTTP data plane with no `IUserContext` fails loud at boot. Shipping open requires typing `auth.devAllowAnonymous=true`, whose name announces the mistake.
- **Bring-your-own-auth is preserved.** Gating on the `AUTH_USER_CONTEXT` *binding* rather than on our subsystem means a consumer's own JWT adapter satisfies the guard. We close the hole without forcing our auth on anyone.
- **Auto-wired, not remembered.** Completing ADR-0002's auto-patch removes the "forgot to call `installRequesterContext`" failure mode that produced #557.
- **Secret entities can leave the data plane entirely** (`api: false`) instead of being merely guarded.

**Cost / negative.**

- **`@Public()` discipline.** The OAuth callback, `/auth/session/*`, and any health/liveness route must be explicitly `@Public()`. Forgetting it makes a genuinely-public route return 401 — a loud, immediate, easy-to-diagnose failure (the safe direction), but real friction to be documented in the auth adoption checklist.
- **Localhost dev needs a decision.** A bare scaffold no longer serves CRUD anonymously by default. Dev/smoke either binds a trivial dev `IUserContext` or sets `auth.devAllowAnonymous=true`. The smoke harness must be updated to do one of these (it is currently a no-auth scaffold).
- **Header path deletion is a behavior change for any consumer relying on `x-user-id`.** Per CLAUDE.md there are no external consumers and no backwards-compat obligation; swe-brain (the one consumer) is migrating to the ALS boundary regardless. Still, it is a real call-site change for anything that posted those headers.
- **Guard reads ALS, not the request.** The guard trusts that the middleware ran first and established context iff `IUserContext` resolved a principal. This couples guard correctness to middleware-runs-before-guard ordering (true in NestJS: Express middleware precedes guards). Documented as an invariant; the §4 boot-fail makes the unbound case impossible to reach silently.
- **CI/publish coupling — each PR carries its own test changes.** Merging to `main` auto-publishes to npm, gated by `just test-all` (unit + baseline + smoke variants). PR2 (§4/§7) extends `test-smoke`: it runs `project upgrade-auth` (asserting AuthModule.forRoot + the main.ts boundary land, idempotently) and adds a standalone `verify-auth-boot.ts` HTTP harness that proves the both-direction posture (401 unauth · 200 authed+ALS-scoped · 200 `@Public`) against the *vendored* auth runtime. (Resolved during implementation: the vendored smoke scaffold does **not** spontaneously boot-fail — vendored `main.ts` carries only the deferral hint, so wiring is exercised explicitly via `upgrade-auth`; and `verify-openapi` had to set `INTEGRATION_TOKEN_ENCRYPTION_KEY` once the upgraded `AppModule` imports `AuthModule`.) PR3 (§5 header-path deletion) **breaks `test-baseline`** (controller-template snapshot drift) and re-gens snapshots in the same PR. The new `auth.devAllowAnonymous` field (§4) is a schema addition to `src/schema/codegen-config.schema.ts` (validated in `config-loader.ts`), not just a read site.

**Neutral.**

- **`@ApiBearerAuth()` stays** on generated controllers — it was already emitted; it now describes an enforced requirement instead of an aspirational one.
- **The guard is authentication, not authorization.** It answers "is there a verified principal," not "may this principal do this." Per-action authorization (RBAC, ownership checks beyond row-scoping) remains a consumer concern, layered on top — same boundary as `IUserContext` resolving *who*, not *what they may do*.
- **`api: false` is orthogonal to auth** — it removes the route; the guard governs routes that remain.

## Alternatives considered

- **Flip the middleware to `onUnresolved: 'reject'`, no guard.** **Rejected:** middleware runs before routing and cannot see `@Public()` metadata, forcing brittle path-string allowlists for the OAuth/session/health routes. A guard reads the exact handler's decorators. Middleware bridges; the guard decides.
- **Per-controller `@UseGuards(AuthenticatedGuard)`.** **Rejected:** this is exactly the per-entity, easy-to-forget work codegen exists to eliminate (ADR-001 "manual consistency across N modules is a losing battle"). One forgotten decorator is an unguarded entity. `APP_GUARD` is the single choke point; `@Public()` is the rare, explicit exception — the safe default inverted.
- **Re-source the actor in the controller (keep threading, read from ALS).** **Rejected:** keeps signature pollution and a second actor source. The ambient context is already the single verified source every repository reads; the controller should not re-launder it. Delete the threading.
- **Closed-always, 401 everything when unbound (no boot-fail).** **Rejected in favor of fail-loud:** a 401-on-every-route bare scaffold is a confusing runtime symptom (looks like a broken app, not a missing binding). Boot-fail with a precise message names the actual cause and the two fixes, and the smoke harness gets a clear signal. (Considered and offered; fail-loud chosen.)
- **Keep "guard only when our subsystem installed; otherwise open" (the original Q1 answer).** **Rejected:** it protects the non-adopter at the cost of leaving the forgetful adopter open — the exact #557 failure. Gating on the `IUserContext` *binding* plus boot-fail closes that without forcing our subsystem.
- **Per-route auth config in YAML instead of `@Public()` decorators.** **Rejected for v1:** a decorator is co-located with the handler, greppable, and type-checked; a YAML allowlist is a second source of truth that drifts. Revisit only if a consumer needs non-code route policy.

## Open follow-ups (implementation-time; not blocking this decision)

1. **Public-route annotation (SHIP-BLOCKER, done in the guard PR).** Resolved during implementation: the package `AuthController` ships only OAuth `connect` + `callback`. `@Public()` is applied to **`callback`** (no session; identity in signed `state`); `connect` stays guarded (requires an authenticated user). Tests assert `callback` carries the public-route metadata and `connect` does not, and neither is entity CRUD. The consumer's own session routes (login/register/resend-verification, e.g. swe-brain's `/auth/session/*`) are annotated in the consumer adoption lane, not this repo.
2. **Smoke harness update + BOTH-direction assertion.** `just test-smoke` scaffolds a no-auth project and curls the data plane. Give it a bound trivial dev `IUserContext` (preferred — exercises the real path) rather than `auth.devAllowAnonymous=true`. Assert **both**: (a) the negative — an unauthenticated entity route returns 401 (the #557 regression guard); and (b) the positive end-to-end — an *authenticated* request passes the guard AND the downstream repository call is actually scoped off the ALS-established principal. (b) is what proves the context propagates *through* the guard, not just that the guard rejects.
3. **`devAllowAnonymous` prod-refusal.** Decide whether to *hard-refuse* `auth.devAllowAnonymous` when the bind address is non-loopback or `NODE_ENV==='production'`, vs. warn-only. Leaning hard-refuse, but it needs a clean "how do we know the bind address at this point in bootstrap" answer.
4. **`api: false` module wiring.** Confirm that suppressing the controller leaves the module's service/use-case bindings intact (in-process reachability) and that nothing in the generated module references the now-absent controller.
5. **AST-patch idempotency for the boot-fail block.** The §7 patch inserts two things after `NestFactory.create` (the `installRequesterContext` call and the boot-fail guard). Ensure re-running `subsystem install auth` / `project upgrade auth` is idempotent (skip-if-present), mirroring `ensureMainSwaggerBlock`.
6. **Worked adoption checklist for swe-brain** (the driving consumer): install/confirm `IUserContext` binding → run `project upgrade auth` to patch `main.ts` + `app.module.ts` → delete any code posting `x-user-id`/`x-tenant-id` → mark internal-only entities `api: false` → verify an unauthenticated entity request returns 401. Pairs with ADR-042's checklist (this is the authentication half; 042 is the isolation half).
