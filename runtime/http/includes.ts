/**
 * The HTTP include allowlist, at request time (REL-2 §5, charter I6).
 *
 * A client never sends an include TREE. It sends a comma-separated list of dot
 * paths — `?include=contacts,opportunities.account` — and the generated
 * controller looks each one up in a map the emitter compiled from the entity
 * YAML. Two properties follow, and they are the whole point:
 *
 *  1. the tree handed to the repository is always one of finitely many
 *     COMPILE-TIME literals, so there is no client-controlled tree construction
 *     anywhere in the request path;
 *  2. a path that is not a key of that map is a `400`, including on a route that
 *     declares no allowlist at all — closed by default.
 *
 * Deliberately framework-free: it throws {@link IncludeNotAllowedError} and the
 * generated controller maps that to Nest's `BadRequestException`, so the rule is
 * unit-testable without booting an app.
 */

/** A client asked for a path the route's allowlist does not name. */
export class IncludeNotAllowedError extends Error {
  override readonly name = 'IncludeNotAllowedError';
  /** Stable wire code — the generated controller sends it in the 400 body. */
  readonly code = 'include_not_allowed' as const;

  constructor(readonly path: string) {
    super(`include not allowed: '${path}'`);
  }
}

/** Split `?include=` into trimmed, non-empty dot paths, in request order. */
export function parseIncludeParam(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Merge two allowlisted fragments.
 *
 * Both sides come from the emitter, so the only shapes here are `true` and
 * `{ with: … }`. `true` loses to `{ with: … }` (asking for `contacts` and
 * `contacts.account` means the deeper one wins), and two `{ with: … }` merge
 * key-wise. Never mutates its inputs — the fragments are `as const` literals
 * shared by every request.
 */
function mergeFragment(a: unknown, b: unknown): unknown {
  if (a === true) return b;
  if (b === true) return a;
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  ) {
    return b;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const out: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    out[key] = key in left ? mergeFragment(left[key], value) : value;
  }
  return out;
}

/**
 * Resolve a request's `?include=` against one route's allowlist.
 *
 * Returns `undefined` when nothing was asked for — the caller then takes the
 * plain, include-free read path. Throws {@link IncludeNotAllowedError} naming the
 * first offending path otherwise.
 *
 * `allow` is the emitted `{ '<dot path>': <fragment> }` map for THIS route, or
 * `undefined` when the entity declares no `api.includes` entry for it. The
 * second case is not "allow everything": it is "allow nothing".
 *
 * The returned tree is typed as the union of the allowlisted fragments, not as
 * one literal — merging happens at runtime. Internal callers keep the exact
 * inferred include type (REL-2 §2.3); an HTTP response is serialized JSON whose
 * OpenAPI schema is generated from the same allowlist, so nothing is lost here.
 */
export function resolveAllowedInclude<TFragment>(
  raw: string | undefined | null,
  allow: Readonly<Record<string, TFragment>> | undefined,
): TFragment | undefined {
  const paths = parseIncludeParam(raw);
  if (paths.length === 0) return undefined;

  let merged: unknown;
  for (const path of paths) {
    const fragment = allow?.[path];
    if (fragment === undefined) throw new IncludeNotAllowedError(path);
    merged = merged === undefined ? fragment : mergeFragment(merged, fragment);
  }
  return merged as TFragment;
}
