/**
 * The HTTP include allowlist, at generation time (REL-2 §5, charter I6).
 *
 * Every rule here is a BUILD error, never a runtime one. An allowlist that names
 * a relation the entity does not have, a path deeper than the route's declared
 * cap, or a path that reaches an `api: false` entity fails the command — so the
 * only include trees that can exist at runtime are compile-time literals the
 * emitter checked (and which `satisfies` re-checks against the manifest's own
 * types inside the consumer project).
 *
 * This lives beside the manifest emitter rather than in the hygen half because
 * resolving a dot path needs the WHOLE relation graph, and re-deriving that graph
 * per entity in `prompt-extension.js` would be a second copy of REL-1's
 * `build-graph.ts` (charter I1). The hygen half only ever reads its own entity's
 * YAML to learn WHICH routes have an allowlist.
 */

import {
  apiEnabled,
  apiIncludes,
  type EntityDefinition,
} from '../../schema/entity-definition.schema';
import { deriveQueryMethodName } from '../../schema/query-routes';
import type { RelationGraph } from './build-graph';
import type { RelationEdge, RelationsEmitContext } from './types';

/** An allowlist declaration that cannot be compiled. Fails the command. */
export class IncludeAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncludeAllowlistError';
  }
}

/** One allowlisted dot path, with the include fragment it compiles to. */
export interface CompiledIncludePath {
  /** The dot path as declared (or implied, for a prefix of a declared path). */
  path: string;
  /** Rendered include literal — `{ contacts: { with: { account: true } } }`. */
  fragment: string;
  /** Hop count. Always `<= route.max_depth`. */
  depth: number;
}

/** One route's compiled allowlist. */
export interface CompiledIncludeRoute {
  route: string;
  maxDepth: number;
  paths: CompiledIncludePath[];
}

/** One entity's compiled allowlist, keyed by route. */
export interface CompiledEntityIncludes {
  entity: string;
  /** The entity's table identifier — the manifest's key for it. */
  table: string;
  routes: CompiledIncludeRoute[];
}

/**
 * `find_by_id` / `list` plus one route per `queries:` finder.
 *
 * The named-search form of a `queries:` entry (`{ name: 'search', filters: … }`)
 * is NOT a finder: it has its own controller and its own query DTO, and an
 * include over a search result is not in scope for REL-2 (§5.4 — the allowlist
 * exposes shapes, not queries).
 */
export function readRouteKeys(def: EntityDefinition): string[] {
  const finders = (def.queries ?? [])
    .filter((q): q is Extract<typeof q, { by: string[] }> => 'by' in q)
    .map((q) => deriveQueryMethodName(q));
  return ['find_by_id', 'list', ...finders];
}

/** `{ a: { with: { b: true } } }` from `['a', 'b']`. */
function renderFragment(keys: string[]): string {
  const [head, ...rest] = keys;
  if (head === undefined) throw new IncludeAllowlistError('empty include path');
  if (rest.length === 0) return `{ ${head}: true }`;
  return `{ ${head}: { with: ${renderFragment(rest)} } }`;
}

/**
 * Compile every entity's allowlist against the relation graph.
 *
 * Throws {@link IncludeAllowlistError} on the first bad declaration, naming the
 * entity, the route and the offending segment.
 */
export function buildIncludeAllowlists(
  ctx: RelationsEmitContext,
  graph: RelationGraph,
): CompiledEntityIncludes[] {
  // Relation lookup: table -> key -> edge. The graph is the single source for
  // what a dot path may traverse, so an allowlist can never name an edge the
  // manifest does not carry (a `through:` relationship, for instance, which
  // REL-1 skips with a warning — REL-2 does not resurrect it as a route).
  const edgesByTable = new Map<string, Map<string, RelationEdge>>();
  for (const { table, edges } of graph.tables) {
    edgesByTable.set(table, new Map(edges.map((e) => [e.key, e])));
  }

  // table -> entity name, so an `api: false` target can be named in the error.
  const entityByTable = new Map<string, string>(
    ctx.entities.map((e) => [e.plural, e.name]),
  );

  const out: CompiledEntityIncludes[] = [];

  for (const entity of ctx.entities) {
    const def = ctx.definitions.get(entity.name);
    if (!def) continue;

    const includes = apiIncludes(def);
    if (includes === undefined || Object.keys(includes).length === 0) continue;

    // Gate decision 1 (strict): an entity with no data plane cannot expose
    // includes over it. Declaring both is the misunderstanding, not the config.
    if (!apiEnabled(def)) {
      throw new IncludeAllowlistError(
        `${entity.name}: 'api.includes' is declared together with 'api: false' — ` +
          `an entity with no HTTP data plane has no route to expose an include on. ` +
          `Remove one of them (ADR-043 §6, ADR-044 §7 revision 2026-09-20).`,
      );
    }

    const validRoutes = new Set(readRouteKeys(def));
    const routes: CompiledIncludeRoute[] = [];

    for (const route of Object.keys(includes).sort()) {
      const decl = includes[route];
      if (decl === undefined) continue;

      if (!validRoutes.has(route)) {
        throw new IncludeAllowlistError(
          `${entity.name}.api.includes: '${route}' is not a generated read route. ` +
            `Valid routes for this entity: ${[...validRoutes].sort().join(', ')}.`,
        );
      }

      // Declaring `a.b` implies `a` — a prefix of an allowed path is allowed, so
      // a client can ask for the shallower shape without a second declaration.
      const wanted = new Set<string>();
      for (const declared of decl.paths) {
        const segments = declared.split('.').map((s) => s.trim());
        if (segments.some((s) => s.length === 0)) {
          throw new IncludeAllowlistError(
            `${entity.name}.api.includes.${route}: '${declared}' is not a dot path over relation keys.`,
          );
        }
        if (segments.length > decl.max_depth) {
          throw new IncludeAllowlistError(
            `${entity.name}.api.includes.${route}: '${declared}' is ${segments.length} hops deep ` +
              `but max_depth is ${decl.max_depth}. Raise the cap or shorten the path — ` +
              `a path longer than the cap is never silently trimmed.`,
          );
        }
        for (let i = 1; i <= segments.length; i += 1) {
          wanted.add(segments.slice(0, i).join('.'));
        }
      }

      const paths: CompiledIncludePath[] = [];
      for (const path of [...wanted].sort()) {
        const segments = path.split('.');
        let table = entity.plural;
        for (const [index, key] of segments.entries()) {
          const edge = edgesByTable.get(table)?.get(key);
          if (!edge) {
            const at = segments.slice(0, index + 1).join('.');
            throw new IncludeAllowlistError(
              `${entity.name}.api.includes.${route}: '${path}' names no relation at '${at}' — ` +
                `table '${table}' has no relation '${key}' in the generated manifest.`,
            );
          }
          const targetEntity = entityByTable.get(edge.targetTable);
          const targetDef =
            targetEntity === undefined ? undefined : ctx.definitions.get(targetEntity);
          // Gate decision 1 (strict): `api: false` means what ADR-043 §6 says it
          // means, with no per-path override. An entity that SHOULD be reachable
          // through a neighbour can simply not be `api: false`.
          if (targetDef !== undefined && !apiEnabled(targetDef)) {
            throw new IncludeAllowlistError(
              `${entity.name}.api.includes.${route}: '${path}' traverses '${targetEntity}', ` +
                `which declares 'api: false'. An entity with no HTTP data plane is not reachable ` +
                `through an exposed neighbour — drop the path, or drop 'api: false' on ` +
                `'${targetEntity}' (ADR-043 §6, ADR-044 §7 revision 2026-09-20).`,
            );
          }
          table = edge.targetTable;
        }
        paths.push({
          path,
          fragment: renderFragment(segments),
          depth: segments.length,
        });
      }

      routes.push({ route, maxDepth: decl.max_depth, paths });
    }

    if (routes.length > 0) {
      out.push({ entity: entity.name, table: entity.plural, routes });
    }
  }

  return out;
}
