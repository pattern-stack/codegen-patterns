/**
 * Ambient requester context — AsyncLocalStorage-backed tenant scope.
 *
 * The alternative to threading `userId`/`organizationId` through every
 * repository/service signature. Set ONCE at each boundary the generated app
 * owns, read implicitly inside `BaseRepository` (see `scopePredicate`).
 *
 * ## Where to set it (boundaries)
 *
 *   - HTTP / tRPC handlers — from the authenticated `ctx.user`
 *   - OAuth callback controllers — from the authenticated session
 *   - Queue/worker `process()` — from the job's owning user after the
 *     job's record is loaded
 *
 * Each boundary wraps the rest of the request in `withRequester({ userId,
 * organizationId }, () => ...)`. The context propagates through every `await`
 * to all downstream repo/service calls without being passed explicitly.
 *
 * ## Where to read it
 *
 *   - `BaseRepository.scopePredicate()` reads it (via `tryGetRequester` in
 *     lenient mode, `requireRequester` in strict mode) and filters every read
 *     by the ambient scope when the repo declares `userTracking: true`.
 *   - `BaseRepository.tenantPredicate()` reads `tenantId` the same way when the
 *     repo declares `tenantScoped: true` (ADR-042 / TEN-1), and `create()`
 *     stamps `tenant_id` from it. The two axes are independent: a repo may
 *     carry either, both, or neither.
 *
 * ## Two axes, one context
 *
 * `userId`/`scope` is the USER axis; `tenantId`/`tenantScope` is the TENANT
 * axis. They are assembled into one WHERE by `scopeAnd()` and never substitute
 * for each other — `scope: 'superuser'` drops the user filter and leaves the
 * tenant filter standing, which is exactly what a background job wants.
 *
 * ## Why AsyncLocalStorage over an explicit parameter
 *
 * Threading `userId` (and later `organizationId`) through dozens of method
 * signatures is pure parameter pollution. Ambient context also lets a repo
 * make the "I forgot to scope" mistake impossible at runtime: in strict mode
 * `requireRequester()` throws when no context is active, surfacing a missing
 * boundary call loudly rather than silently leaking cross-tenant data.
 *
 * ## Not-found semantics
 *
 * When a row exists but belongs to a different requester, scoped reads return
 * `null`/`[]` — identical to "truly doesn't exist". No existence oracle;
 * callers throw NotFound uniformly. Standard security practice.
 *
 * ## Testing
 *
 * Tests that exercise scoped repos must wrap the call in `withRequester(...)`.
 * In strict mode an unwrapped call hitting `requireRequester()` throws — by
 * design. In lenient mode (the default) an unwrapped call is simply unscoped.
 * A tenant-scoped entity is emitted strict, so its tests MUST supply a
 * `tenantId` (or use `withAllTenants`) — there is no lenient opt-down.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Data-visibility scope. The auth layer decides which scope a request is
 * allowed to claim; the repo trusts whatever the ambient context says.
 *
 * - `'user'`: filter every read by `user_id = ctx.userId`. Default.
 * - `'org'`: filter every read by membership in the requester's org, resolved
 *   via `user_id IN (ctx.orgUserIds)` rather than via a per-entity
 *   `organization_id` column. Works for every user-owned table and keeps repos
 *   single-table — the org member list is pre-resolved at the boundary.
 * - `'superuser'`: no scope filter. Engineering / internal-tools only.
 *
 * AUTHORIZATION (who is allowed to claim each scope) lives in boundary
 * middleware, not in the repo. The repo trusts the ambient context — same
 * trust model as a threaded `userId`.
 */
export type RequesterScope = 'user' | 'org' | 'superuser';

export interface RequesterContext {
  /**
   * The user making the request. Always present — even in `'org'` and
   * `'superuser'` scopes it is the audit-trail "who actually did this".
   */
  readonly userId: string;
  /**
   * The organization the requester belongs to. Required when
   * `scope === 'org'`; may be null for `'user'` (users with no org) and for
   * `'superuser'` (cross-org reads).
   */
  readonly organizationId: string | null;
  /**
   * Data-visibility scope. Defaults to `'user'` when omitted.
   */
  readonly scope?: RequesterScope;
  /**
   * For `scope === 'org'`: the list of user IDs in the requester's org,
   * pre-resolved by the boundary middleware that established the `'org'`
   * scope (one `SELECT users.id WHERE organization_id = X` at the trust
   * boundary). Repos use this as a literal `IN (...)` filter — they never
   * JOIN to `users` themselves. Required when `scope === 'org'`.
   */
  readonly orgUserIds?: readonly string[];
  /**
   * The tenant this request acts within (ADR-042 / TEN-1). Read by
   * `BaseRepository.tenantPredicate()` when the repo declares
   * `tenantScoped: true`. Three states, all meaningful:
   *
   *   - `string`  → scope every read/write to this tenant.
   *   - `null`    → the null-tenant PARTITION (system / cross-tenant rows):
   *                 filters `IS NULL`, stamps NULL on create. NOT a wildcard.
   *   - absent    → no tenant established. `'lenient'` → unscoped;
   *                 `'strict'` → throws `MissingTenantIdError`.
   *
   * Seeded at the SAME boundary that seeds `userId` (see "Where to set it").
   * A tenant-scoped entity is emitted `'strict'`, so absent is a loud failure.
   */
  readonly tenantId?: string | null;
  /**
   * Tenant-axis visibility — the counterpart of `scope` on the user axis.
   *
   *   - `'tenant'` (default) → apply the tenant predicate.
   *   - `'all'`              → drop it. Cross-tenant tooling: tenant
   *     resolution at signup, super-admin reads, migrations. Reads see every
   *     tenant; WRITES must supply `tenantId` explicitly or `stampTenant()`
   *     throws — reading across tenants is a choice, writing without naming
   *     the owner is a bug.
   *
   * Set via `withAllTenants(fn)`, never hand-assembled at a boundary.
   */
  readonly tenantScope?: 'tenant' | 'all';
}

const als = new AsyncLocalStorage<RequesterContext>();

/**
 * Set the ambient requester context for the duration of `fn`. The context
 * propagates through `await` boundaries to all downstream calls. Nesting is
 * fine — an inner `withRequester` overrides the outer for its callback.
 */
export function withRequester<T>(
  ctx: RequesterContext,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run(ctx, fn);
}

/**
 * Read the ambient requester context. Throws if no context is active — by
 * design. Used by repos in strict scope-enforcement mode; an unwrapped call
 * site is a missing boundary.
 */
export function requireRequester(): RequesterContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error(
      'No requester context active. Wrap the entry point in ' +
        'withRequester({ userId, organizationId }, fn). See tenant-context.ts.',
    );
  }
  return ctx;
}

/**
 * Read the ambient requester context without throwing. Returns `undefined`
 * when no context is active. Used by repos in lenient scope-enforcement mode
 * (the default) and by code paths that legitimately run outside a request.
 */
export function tryGetRequester(): RequesterContext | undefined {
  return als.getStore();
}

/**
 * Resolve the effective scope for the ambient context, defaulting to `'user'`.
 */
export function requireRequesterScope(): RequesterScope {
  return requireRequester().scope ?? 'user';
}

/**
 * Convenience helpers for setting scope explicitly. All three preserve
 * `userId` in the context (audit trail) regardless of scope.
 *
 * - `withUserScope`: regular end-user requests. Most call sites.
 * - `withOrgScope`: admin / org-shared resource access. The caller MUST verify
 *   the requester's role permits `'org'` before calling — the helper does not
 *   enforce authorization. `orgUserIds` is pre-resolved at the boundary.
 * - `withSuperuserScope`: engineering scripts / internal tools. `organizationId`
 *   is null (cross-org is the point). Same authorization caveat applies.
 */
export function withUserScope<T>(
  userId: string,
  organizationId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return withRequester({ userId, organizationId, scope: 'user' }, fn);
}

export function withOrgScope<T>(
  userId: string,
  organizationId: string,
  orgUserIds: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  return withRequester(
    { userId, organizationId, scope: 'org', orgUserIds },
    fn,
  );
}

export function withSuperuserScope<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withRequester(
    { userId, organizationId: null, scope: 'superuser' },
    fn,
  );
}

// ============================================================================
// Tenant axis (ADR-042 / TEN-1)
// ============================================================================

/**
 * Sentinel actor for work that no user initiated — the background worker
 * entering the ALS from a job run's own tenant (see the jobs subsystem's
 * `JobWorker.processRun`). `job_run` carries a tenant but no user, so the
 * audit-trail `userId` field needs a value that is obviously not a person.
 *
 * It is paired with `scope: 'superuser'` at every site that uses it: a job is a
 * TENANT-level actor, not a user-level one. Entering the ALS with this id under
 * the default `'user'` scope would filter every `userTracking` repository to a
 * user that does not exist, silently returning nothing.
 */
export const SYSTEM_ACTOR_ID = '__system__';

/**
 * Raised when a tenant-scoped repository cannot resolve a tenant under
 * `scopeEnforcement: 'strict'` — i.e. a context is active but carries no
 * `tenantId`, or `withAllTenants` is in effect on a WRITE.
 *
 * Mirrors the jobs subsystem's error of the same name (`jobs-errors.ts`) in
 * shape and three-state contract, but is deliberately a SEPARATE class:
 * `base-classes` must not depend on a subsystem (the arrow points the other
 * way — `auth` imports this file), and the two carry different payloads.
 *
 * `owner` names the repository, so the throw points at the declaration.
 */
export class MissingTenantIdError extends Error {
  override readonly name = 'MissingTenantIdError';

  constructor(public readonly owner: string) {
    super(
      `${owner}: no tenant in the ambient requester context. This repository ` +
        'is tenant-scoped and enforcing strictly, so it will not read or write ' +
        'unscoped. Install a boundary that calls ' +
        'withRequester({ userId, organizationId, tenantId }, fn) — or, for ' +
        'deliberate cross-tenant work, withAllTenants(fn) / ' +
        'withTenantScope(tenantId, fn). See tenant-context.ts.',
    );
  }
}

/**
 * Read the ambient tenant for a repository enforcing at `enforcement`.
 *
 *   - `'lenient'` → `undefined` when there is no context OR the context
 *     carries no tenant. The caller (the tenant predicate) then applies no
 *     filter, which preserves pre-scoping behaviour.
 *   - `'strict'`  → NEVER returns `undefined`. Two distinct throw sites:
 *     `requireRequester()` for "no context at all", and `MissingTenantIdError`
 *     for "a context that forgot the tenant". The second matters: without it an
 *     absent tenant would return `undefined` and read UNSCOPED under strict,
 *     which is the exact failure tenant scoping exists to prevent.
 *
 * An explicit `null` is a value, not an absence: it selects the null-tenant
 * partition (system / cross-tenant rows) and passes in both modes.
 */
export function getTenantId(
  enforcement: 'lenient' | 'strict',
  owner: string,
): string | null | undefined {
  if (enforcement !== 'strict') return tryGetRequester()?.tenantId;
  const ctx = requireRequester();
  if (ctx.tenantId === undefined) throw new MissingTenantIdError(owner);
  return ctx.tenantId;
}

/**
 * Run `fn` acting within `tenantId` — or, with `null`, within the null-tenant
 * partition. The escape hatch for deliberate cross-tenant work that still has
 * ONE owner: an admin acting on a named tenant, a migration walking tenants.
 *
 * Requires an outer context (it inherits `userId` / `scope` from it) — a
 * boundary is still a boundary. To act with no tenant filter at all, use
 * `withAllTenants`.
 */
export function withTenantScope<T>(
  tenantId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return withRequester({ ...requireRequester(), tenantId, tenantScope: 'tenant' }, fn);
}

/**
 * Run `fn` across EVERY tenant — super-admin tooling, and the bootstrap case
 * that cannot be expressed any other way: resolving which tenant a signup
 * belongs to, when the tenant lookup itself cannot be tenant-scoped.
 *
 * Reads drop the tenant predicate entirely. WRITES still require an explicit
 * `tenantId` on the input — `stampTenant()` throws otherwise. Reading across
 * tenants is a deliberate choice; writing a row without naming its owner is a
 * bug in every case.
 *
 * Requires an outer context, for the same reason `withTenantScope` does.
 */
export function withAllTenants<T>(fn: () => Promise<T>): Promise<T> {
  return withRequester({ ...requireRequester(), tenantScope: 'all' }, fn);
}
