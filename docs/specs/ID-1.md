# ID-1: workspaces, membership and the requester (identity, first release)

**Status:** implemented · **Follows:** S-2 (#983) · **Plan:** codegen-targets `docs/PLAN-identity.md` (Doug, 2026-11-27)

## Problem

A pattern-stack app has tenant scoping (`tenant_scoped`, the request state's `tenantId`) and nothing that says who a
request is or which workspace it acts in. There is no workspace, no membership, and no check on every request that
the principal belongs to the workspace it names. H-2's middleware needs one port to call for that.

## Decision

### The requester port (`runtime/requester.ts`, Nest-free)

Agreed with the Hono lane (H-2 calls it; this step implements it):

```ts
export interface RequestFacts { header(name: string): string | undefined; path: string }
export interface RequesterRefusal { reason: 'unauthenticated' | 'not-a-member' | 'bad-workspace'; detail: string; instead: string }
export type RequesterOutcome = { requester: RequesterContext } | { refusal: RequesterRefusal };
export interface RequesterPort { resolve(request: RequestFacts): Promise<RequesterOutcome> }
/** Who a request is: the app's sign-in (the identity release after this one ships one). Null: nobody signed in. */
export interface PrincipalSource { principalOf(request: RequestFacts): Promise<string | null> }
```

- No HTTP status in the port: H-2 owns a reason → status table (401, 403, 400).
- A request that names no workspace resolves to `{ userId }` with no `tenantId`, so a tenant-scoped read then throws
  (strict), by design. Creating a workspace and listing mine need no workspace.
- `RequesterContext` gains `role?: string`, the principal's role in that workspace.
- `runtime/errors.ts` gains `UnauthorizedError` (401), `ForbiddenError` (403) and `ConflictError` (409), with Nest's
  bodies. The workspace operations throw them, and H-2 builds its refusal bodies from them.

### Every option is a registry row

Each port has a table keyed by its config value, one row per backend pointing at its factory, typed
`Record<Name, Factory>`, where `Name` comes from a leaf list (`WORKSPACE_SOURCE_NAMES`, …) that the config schema's
enum is built from. So a value with no row fails `tsc`, and a value the schema doesn't know is refused, naming the
rows. The generated system picks a row with `REGISTRY['<value>']`, which is the only place a backend is chosen. There
is no `if`, `switch` or ternary on a config value.

| Registry | Rows | Default |
|---|---|---|
| `WORKSPACE_SOURCES` | `header` (`X-Workspace`), `path` (`/w/:workspaceId/…`; the row also gives H-2 the route prefix) | `header` |
| `REQUESTER_RESOLVERS` | `lookup`: the principal from the `PrincipalSource`, the workspace from the source, the role from the cache | `lookup` |
| `REQUESTER_CACHES` | `postgres`, `memory` | `postgres` |

```yaml
identity:
  workspace_from: header
  requester: { resolver: lookup, cache: postgres }
tenancy:
  column: workspace_id        # the install sets it: every tenant_scoped entity points at the workspace
```

### The requester cache

Core contract: `role(principalId, workspaceId) → role | null` (filled through a lookup the system gives it),
`invalidate({ principalId, workspaceId }, tx)`, `start`, `stop`. It caches "not a member" too.

- **`postgres`:** `invalidate` sends `pg_notify('identity_requester', <json>)` on the write's own transaction, so it
  is delivered only on commit. Every process holds a `PgNotifyListener` on that channel and evicts the entry. Each
  key has an epoch, bumped on every eviction, so a fill that read the old row before the eviction can't store it
  after. While the listener is down, it reads through and stores nothing, because it can't hear evictions. When the
  listener connects (the first time, and on every reconnect), it clears every entry and starts caching again. For
  that, `PgNotifyListener` (`events/pg-notify.ts`) gains two optional callbacks, `onConnect` and `onDrop`.
- **`memory`:** `invalidate` evicts at once. For tests and one process.

### The entities

`subsystem install identity` vendors three YAMLs into `<entities>/identity/` (`context: identity`, so they compose as
the `identity` module):

| Entity | Fields | Notes |
|---|---|---|
| `user` | `email` (unique), `display_name` | `api: false`, `generate: { commands: false }`. Created by the app (and by sign-in, next release) |
| `workspace` | `name`, `slug` (unique) | `api: false`, `generate: { writes: false, commands: false }`: written only by the workspace operations |
| `membership` | `workspace` and `user` (`belongs_to`, `on_delete: restrict`), `role` (enum), `invited_by` | `api: false`, `writes: false`, `commands: false`; unique `(workspace_id, user_id)`; queries by the pair, by user, by workspace |

None of the three gets generated commands (`generate.commands: false`, the derivation's one switch,
`commandsDisabledBy`): a generic `membership list` would read every workspace's memberships. Their only commands are
the hand-written, rights-checked ones (the follow-up on the command layer). Membership's references are `restrict`:
a cascade from a user or workspace delete would remove memberships with no invalidation.

`role`'s choices must be exactly the role table's (`owner`, `admin`, `member`). `entity new` refuses otherwise, naming
the YAML. There is no `identity.roles` key, which the plan had: the YAML is the declaration, and a second list would
only drift from it.

### The workspace operations (`WorkspaceService`, runtime)

Typed over structural ports of the generated repositories, as the connection store is (S-2). Every write runs in one
transaction with the cache invalidation, and reads the requester from the request state:

- `createWorkspace({ name, slug })`: any signed-in principal. It writes the workspace and the principal's `owner`
  membership together.
- `addMember({ userId, role })`, `changeRole({ userId, role })`, `removeMember({ userId })`: in the requester's
  workspace. Allowed for an `owner` or `admin`; only an owner grants or takes away `owner`; the last owner can't be
  demoted or removed (`ConflictError`). A user who doesn't exist is `NotFoundError`, and one already a member is
  `ConflictError`.
- `listMine()`: the principal's workspaces, each with its role.

What each role may do is one table (`ROLE_RIGHTS`: `manage`, `manageOwners`), not branches. They become commands when
H-1 is under this step: hand-written ones in the identity context's own list, next to the generated ones.

### Under pattern-stack

- **`requester` system** (`<generated>/requester-system.ts`), `uses: ['database']`. It builds its own membership
  repository, as the `connections` system does (a system can't depend on a module, and a repository is stateless over
  `db`), and picks the cache, the workspace source and the resolver from their registries. Its API is the
  `RequesterPort` plus `requesterFor({ principalId, workspaceId })` for jobs and agents, and the cache. `start` and
  `stop` run the cache's listener.
- **The principal source** is the app's: `<backend_src>/identity/principal-source.ts`, written once and owned by the
  author. As written, it lets nobody in, so every resolve is `unauthenticated`. Its comment shows a dev header to read
  instead. Sign-in replaces it in the next release.
- **`workspaces` module** (`<generated>/workspaces-module.ts`): `dependsOn: ['identity']`, `uses: ['database',
  'requester']`. It builds `WorkspaceService` over the identity module's repositories and the requester cache.
- `subsystem install identity` is refused under Nest, naming the plan's Nest step.

## Not in this step

- Sign-in, sessions and the `sid` check (the next release); the email system.
- H-2's middleware, statuses and public routes (the Hono lane).
- The `subdomain` and `token_claim` sources, the `signed_token` resolver and the `redis` cache: rows added later.
- Identity under Nest.

## The gate

- `test-smoke-pattern-stack` installs identity. It asserts the vendored Nest-free closure, the three YAMLs, the config
  block and `tenancy.column`, and that `requester-system.ts`, `workspaces-module.ts` and the principal source exist.
  `tsc` passes, and `main.ts` composes `requester` and `workspaces`.
- On Postgres (the integration job), `crud-check`:
  - A creates a workspace, is its owner, and lists it;
  - B, added as a member, resolves with `role: 'member'`; C, not a member, is refused `not-a-member`; a malformed
    `X-Workspace` is `bad-workspace`, and no principal is `unauthenticated`;
  - B is promoted to admin; the last owner can't leave or be demoted;
  - **across processes:** a second composed app (its own listener) caches B's membership, the first removes B, and the
    second refuses B within two seconds;
  - **on reconnect:** the second app's listener backend is terminated (`pg_terminate_backend`); a change made while it
    is down is not served from the cache, and after it reconnects the cache was cleared.
- Unit tests: the registries (every name has a row; an unknown value refused, naming the rows), both workspace sources,
  the resolver's four outcomes, the memory cache, the Postgres cache's epoch and listener states (a fake listener),
  `WorkspaceService`'s rights table and last-owner rules, the new errors' bodies, the install (refusal under Nest,
  files, config), and the composition's two files and refusals.
- Nest: the baseline, the goldens and every Nest smoke unchanged.

## As built

- **Review fixes (#987's independent review):**
  - **Ids are normalised where they come in.** `WorkspaceService` lowercases every user and workspace id (and refuses
    one that isn't a uuid, `bad_user_id`) before any check, so the leaving check, the owner count and the cache key
    see the same id: an upper-case id can't remove the last owner.
  - **The target's membership is read inside the change's transaction and locked** (`membershipForUpdate`, a
    `SELECT … FOR UPDATE` the generated module builds, next to `ownersForUpdate`). Every rights check runs on that
    locked row, so a concurrent promote can't slip an owner past an admin's remove.
  - **A quietly dead listener can't serve stale roles for long.** `PgNotifyListener` gains an optional heartbeat
    (`heartbeatMs`, off by default; identity's cache runs `SELECT 1` every 10 s, dead after 5 s), so a half-open
    socket becomes a drop. And no cache entry is served longer than `REQUESTER_CACHE_MAX_AGE_MS` (30 s), aged from when
    its read began, the backstop for any notification that never comes.
  - **No cascade around the invalidation:** membership's references are `restrict` (above).
  - The reconnect check can fail on its subject: it runs on a cache whose listener reconnects after 2 s, removes a
    membership with its notification while nobody listens, and asserts the role isn't served after the reconnect. With
    the drop and connect clears removed, it fails.
  - Every listener connection is named `pg-notify:<label>` (`application_name`), so its backend can be found.
  - One pool probe (`listenerPoolOf`) for every LISTEN user; one list of identity's entities (`IDENTITY_ENTITIES`);
    the missing-workspace message is the configured source's `instead`; transaction handles are typed `DrizzleTx`.
  - Registry rows, not branches: the install's runtime step is a row per runtime mode (`IDENTITY_RUNTIME_STEP`), and
    the Nest refusal a row per wiring (`IDENTITY_INSTALL`).

- **The cache contract has `evict`.** `invalidate(key, tx)` runs in the change's transaction (Postgres sends the
  notification, delivered on commit), and the workspace operations call `evict(key)` once the transaction committed,
  so the writing process needn't wait for its own notification. A fill that read the old row before an eviction
  doesn't store it: both backends keep their entries in `CacheEntries`, where each fill in flight holds a token that
  an eviction or a clear marks. Tokens live only while their fills do, so nothing grows with the keys evicted.
- **The last owner is checked inside the write's transaction, the owners locked** (`ownersForUpdate`, a
  `SELECT … FOR UPDATE` on the workspace's owner memberships). Two owners stepping down at once: the second waits for
  the first and then sees one owner left.
- **Two adds of one user at once** are both `already_a_member` (409): the second is refused by the
  `(workspace_id, user_id)` unique index, and the service maps that violation (`constraintViolationOf`).
- **Ids:** the resolver lowercases the principal and workspace ids and the cache key does too, so a job passing an
  upper-case id shares the request path's entry. A principal id that isn't a uuid (the principal source returned
  something other than a user's id) is `unauthenticated`, not a database error.
- **No unchecked role.** A request state with a workspace and no role (built by hand, never resolved) gets
  `ForbiddenError` (`role_unresolved`) from the workspace operations, rather than a member's rights.
- **The tenant column is set only when none is in use.** The install writes `tenancy.column: workspace_id` only when
  the project has no `tenancy:` block and no `tenant_scoped` entity. Otherwise it keeps the column in use and says
  so, because renaming it would drop and re-add every tenant column.
- **The listener lives in `events/pg-notify.ts`** (the jobs engine moved it there). The `onConnect` and `onDrop` hooks
  are on it, and the identity install vendors it with the events protocol type it imports. A project with identity
  and without events therefore lists events as `incomplete` in `subsystem list`. Nothing composes it.
- **In package mode** the install records `identity` under `subsystems.install` and vendors no runtime. The YAMLs,
  the config block and the principal source are written the same way. In `--json` mode too, the install regenerates
  the subsystem schema barrel.
- **The gate can fail on its subject:** with the `pg_notify` removed, the cross-app check fails (the second app keeps
  B); with the drop and connect hooks emptied, the reconnect check fails.
