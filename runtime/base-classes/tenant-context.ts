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
