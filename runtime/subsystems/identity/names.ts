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

/** The membership roles: `membership.yaml`'s `role` choices must be exactly these (the rights table is keyed by them). */
export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** The config defaults: an `X-Workspace` header, checked on every request through the Postgres-invalidated cache. */
export const IDENTITY_DEFAULTS = {
  workspace_from: 'header',
  requester: { resolver: 'lookup', cache: 'postgres' },
} as const satisfies {
  workspace_from: WorkspaceSourceName;
  requester: { resolver: RequesterResolverName; cache: RequesterCacheName };
};
