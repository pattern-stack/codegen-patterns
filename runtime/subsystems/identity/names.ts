/**
 * Identity's registry keys (ID-1): the one list of each port's backends. Leaf module, importing nothing, so the config
 * schema builds its enums from these and each registry is typed `Record<Name, Factory>` over them: a name with no row
 * fails `tsc`, and a config value with no name is refused by the schema, naming the rows.
 */

/** How a request names its workspace. */
export const WORKSPACE_SOURCE_NAMES = ['header', 'path'] as const;
export type WorkspaceSourceName = (typeof WORKSPACE_SOURCE_NAMES)[number];

/** How the requester is checked. */
export const REQUESTER_RESOLVER_NAMES = ['lookup'] as const;
export type RequesterResolverName = (typeof REQUESTER_RESOLVER_NAMES)[number];

/** Where the `lookup` resolver caches memberships. */
export const REQUESTER_CACHE_NAMES = ['postgres', 'memory'] as const;
export type RequesterCacheName = (typeof REQUESTER_CACHE_NAMES)[number];

/** Identity's entities: the YAMLs `subsystem install identity` vendors, and what the composition needs of them. */
export const IDENTITY_ENTITIES = ['user', 'workspace', 'membership'] as const;
export type IdentityEntity = (typeof IDENTITY_ENTITIES)[number];

/**
 * How long a cached membership may be served, at most (ms). Eviction is what keeps the cache right; this bounds what a
 * notification that never arrives can cost (a quietly dead listener, a delete outside the workspace operations).
 */
export const REQUESTER_CACHE_MAX_AGE_MS = 30_000;

/** The `postgres` cache's listener heartbeat: a `SELECT 1` this often, dead after the timeout (ms). */
export const REQUESTER_LISTENER_HEARTBEAT = { everyMs: 10_000, timeoutMs: 5_000 } as const;

/** The membership roles: `membership.yaml`'s `role` choices must be exactly these (the rights table is keyed by them). */
export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/**
 * A workspace's field limits, as the commands' input checks them: `workspace.yaml`'s `max_length`s (a test holds the
 * shipped YAML to these), so a name too long is `invalid-input`, never the database's truncation error.
 */
export const WORKSPACE_FIELD_MAX = { name: 255, slug: 64 } as const;

/** The config defaults: an `X-Workspace` header, checked on every request through the Postgres-invalidated cache. */
export const IDENTITY_DEFAULTS = {
  workspace_from: 'header',
  requester: { resolver: 'lookup', cache: 'postgres' },
} as const satisfies {
  workspace_from: WorkspaceSourceName;
  requester: { resolver: RequesterResolverName; cache: RequesterCacheName };
};
