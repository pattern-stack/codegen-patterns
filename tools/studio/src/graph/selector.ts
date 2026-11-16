/**
 * dbt-style selectors for the canvas filter box (STUDIO-5).
 *
 * The box holds space-separated tokens; what is shown is the UNION of what
 * each token selects.
 *
 *   name        no `+`: today's text filter — label, table, group, field and
 *               type names, case-insensitive substring
 *   name+       the entity and what depends on it (its children, transitively)
 *   +name       the entity and what it depends on (its parents, transitively)
 *   +name+      both
 *   name+N      N hops of children; `N+name` N hops of parents; `2+name+3` both
 *
 * A bare `+` is unlimited; a number limits the hops and is 1 or more. A token
 * with a `+` names exactly one entity (its id or its label, ignoring case); a
 * name that matches nothing, and a token the grammar cannot read (`++a`,
 * `a+b`, `0+a`, `+`), select nothing and each produce a message the box shows.
 *
 * **Direction.** Every line has a `parent` and a `child` end, set by the
 * adapter (the same two the tree layout reads): the child depends on the
 * parent. A `belongs_to` — and a role, which is one underneath — puts the FK
 * holder at the child end and the referenced entity at the parent end; an
 * `inherits` puts the child entity under its base; an unpaired `has_many` /
 * `has_one` is oriented by its foreign key the same way. Hops follow every
 * line — spine, secondary, `inherits`, role — never only the spine.
 *
 * **Junctions.** A first-class relationship node sits between its two ends,
 * each of which is its parent. Crossing it from one end to the other is ONE
 * hop, in either direction (a many-to-many has no dependent end), and the
 * junction node is shown with the far end. The junction is a pass-through:
 * the walk continues from the far end, not from the junction. Selecting the
 * junction by name walks its own lines like any node (`+link` = it and both ends).
 *
 * Pure: no React, no DOM. Unit-tested in `../__tests__/selector.test.ts`.
 */

/** Unlimited hops — a bare `+`. */
export const UNLIMITED = Number.POSITIVE_INFINITY;

export type SelectorToken =
  /** No `+`: the plain text filter. */
  | { kind: 'text'; raw: string }
  /** `up` hops of parents, `down` hops of children; 0 = that side was not asked for. */
  | { kind: 'select'; raw: string; name: string; up: number; down: number }
  | { kind: 'malformed'; raw: string; reason: string };

/** `[N]+` name `+[N]` — each side optional, a side's digits optional. */
const SELECTOR = /^(?:(\d*)\+)?([^+]+?)(?:\+(\d*))?$/;

function depthOf(side: string | undefined): number {
  if (side == null) return 0;
  if (side === '') return UNLIMITED;
  return Number(side);
}

export function parseToken(raw: string): SelectorToken {
  if (!raw.includes('+')) return { kind: 'text', raw };
  const m = SELECTOR.exec(raw);
  if (m == null || (m[1] == null && m[3] == null)) {
    return { kind: 'malformed', raw, reason: 'is not a selector — write name+, +name, 2+name+3' };
  }
  const up = depthOf(m[1]);
  const down = depthOf(m[3]);
  if ((m[1] != null && up === 0) || (m[3] != null && down === 0)) {
    return { kind: 'malformed', raw, reason: 'has a depth of 0 — a depth is 1 or more, or a bare + for all' };
  }
  return { kind: 'select', raw, name: m[2]!, up, down };
}

/** The box's text as tokens; whitespace separates, empty input is no tokens. */
export function parseSelector(input: string): SelectorToken[] {
  return input
    .split(/\s+/)
    .filter((t) => t !== '')
    .map(parseToken);
}

/** The selector a double-clicked card sets: one hop each way. */
export function focusSelector(name: string): string {
  return `1+${name}+1`;
}

/** What the selector needs of a node — `GraphNodeData` satisfies it. */
export interface SelectorNode {
  id: string;
  label: string;
  /** `relationship` is a junction node; any other kind is an ordinary card. */
  kind: string;
  subtitle?: string;
  group?: string;
  fields?: readonly { name: string }[];
  types?: readonly { name: string }[];
}

/** What the selector needs of a line — `StudioEdgeData` satisfies it. */
export interface SelectorEdge {
  parent: string;
  child: string;
}

export interface SelectorMessage {
  token: string;
  text: string;
}

export interface SelectorResult {
  /** The node ids shown; `null` when the box is empty — nothing is filtered. */
  ids: Set<string> | null;
  messages: SelectorMessage[];
}

/**
 * The text filter a token without `+` applies — the component library's
 * `useGraphFilter` match, per token. It is restated here because the union
 * needs it once per token and the library exposes it only as a hook.
 */
export function matchesText(node: SelectorNode, text: string): boolean {
  const q = text.toLowerCase();
  if (node.label.toLowerCase().includes(q)) return true;
  if (node.subtitle?.toLowerCase().includes(q)) return true;
  if (node.group?.toLowerCase().includes(q)) return true;
  if (node.fields?.some((f) => f.name.toLowerCase().includes(q))) return true;
  if (node.types?.some((t) => t.name.toLowerCase().includes(q))) return true;
  return false;
}

/** The node a selector token names: its id exactly, else its id or label ignoring case. */
function resolveName(name: string, nodes: readonly SelectorNode[]): SelectorNode | undefined {
  const exact = nodes.find((n) => n.id === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return nodes.find((n) => n.id.toLowerCase() === lower || n.label.toLowerCase() === lower);
}

type Direction = 'up' | 'down';

/** Adjacency over every line, both ways, plus which nodes are junctions. */
function indexGraph(nodes: readonly SelectorNode[], edges: readonly SelectorEdge[]) {
  const present = new Set(nodes.map((n) => n.id));
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key) ?? new Set<string>();
    set.add(value);
    map.set(key, set);
  };
  for (const e of edges) {
    if (e.parent === e.child || !present.has(e.parent) || !present.has(e.child)) continue;
    add(parents, e.child, e.parent);
    add(children, e.parent, e.child);
  }
  const junctions = new Set(nodes.filter((n) => n.kind === 'relationship').map((n) => n.id));
  return { parents, children, junctions };
}

type GraphIndex = ReturnType<typeof indexGraph>;

/**
 * One hop from `id`: the nodes reached, and the junctions crossed to reach
 * them (shown, never walked on from).
 */
function hop(index: GraphIndex, id: string, direction: Direction): { reached: string[]; crossed: string[] } {
  const reached: string[] = [];
  const crossed: string[] = [];
  const own = (direction === 'up' ? index.parents : index.children).get(id) ?? new Set<string>();
  for (const n of own) {
    // A junction below an end is crossed by the rule that follows, both ways.
    if (index.junctions.has(n) && index.parents.get(n)?.has(id)) continue;
    reached.push(n);
  }
  for (const j of index.children.get(id) ?? []) {
    if (!index.junctions.has(j)) continue;
    crossed.push(j);
    for (const far of index.parents.get(j) ?? []) if (far !== id) reached.push(far);
  }
  return { reached, crossed };
}

/** Breadth-first from `start`, at most `depth` hops in one direction. */
function walk(index: GraphIndex, start: string, direction: Direction, depth: number, into: Set<string>): void {
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const { reached, crossed } = hop(index, id, direction);
      for (const j of crossed) into.add(j);
      for (const n of reached) {
        if (seen.has(n)) continue;
        seen.add(n);
        into.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
}

/** What the box's text shows: the union of its tokens, and a message per token that selected nothing it could. */
export function applySelector(
  input: string,
  nodes: readonly SelectorNode[],
  edges: readonly SelectorEdge[],
): SelectorResult {
  const tokens = parseSelector(input);
  if (tokens.length === 0) return { ids: null, messages: [] };

  const ids = new Set<string>();
  const messages: SelectorMessage[] = [];
  let index: GraphIndex | null = null;

  for (const token of tokens) {
    if (token.kind === 'text') {
      for (const n of nodes) if (matchesText(n, token.raw)) ids.add(n.id);
      continue;
    }
    if (token.kind === 'malformed') {
      messages.push({ token: token.raw, text: `${token.raw} ${token.reason}` });
      continue;
    }
    const node = resolveName(token.name, nodes);
    if (node == null) {
      messages.push({ token: token.raw, text: `No entity named ${token.name}` });
      continue;
    }
    index ??= indexGraph(nodes, edges);
    ids.add(node.id);
    walk(index, node.id, 'up', token.up, ids);
    walk(index, node.id, 'down', token.down, ids);
  }

  return { ids, messages };
}
