/**
 * The requester port (ID-1): who a request is, and in which workspace. Framework-free, so every way in shares it.
 *
 * HTTP (H-2's middleware) builds `RequestFacts` from its request, calls `resolve`, turns a refusal into its own status
 * (a table there, not here) and runs the rest of the request inside `withRequester(requester, …)`. A job or an agent,
 * which has no request, asks the identity `requester` system's `requesterFor({ principalId, workspaceId })` instead.
 * Public routes never reach the port: that list is the HTTP layer's.
 */
import type { RequesterContext } from './base-classes/tenant-context';

/** What a way in knows about a request. Hono builds it from `c.req`; a CLI or MCP from its own boundary. */
export interface RequestFacts {
  /** A request header, by case-insensitive name. */
  header(name: string): string | undefined;
  /** The URL path, without the query string. */
  path: string;
}

/** Why a request has no requester. Each carries what to do instead, so every way in can print it. */
export interface RequesterRefusal {
  readonly reason: 'unauthenticated' | 'not-a-member' | 'bad-workspace';
  readonly detail: string;
  readonly instead: string;
}

export type RequesterOutcome = { readonly requester: RequesterContext } | { readonly refusal: RequesterRefusal };

export interface RequesterPort {
  /**
   * Who the request is, and in which workspace. A request that names no workspace resolves to `{ userId }` with no
   * `tenantId`, so a tenant-scoped read then throws, by design.
   */
  resolve(request: RequestFacts): Promise<RequesterOutcome>;
}

/** Who the principal is, from the app's sign-in. Null: nobody signed in. */
export interface PrincipalSource {
  principalOf(request: RequestFacts): Promise<string | null>;
}

/** `RequestFacts` over a plain header map (tests, a CLI): names are matched case-insensitively. */
export function requestFacts(path: string, headers: Readonly<Record<string, string | undefined>> = {}): RequestFacts {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { path, header: (name) => lower.get(name.toLowerCase()) };
}
