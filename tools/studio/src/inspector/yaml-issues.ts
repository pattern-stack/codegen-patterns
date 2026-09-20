/**
 * Map a server-reported Zod issue onto a position in the YAML the editor holds.
 *
 * A 422 from `PUT /api/files/:path` carries `ZodIssueLike.path` — the schema
 * path of the offending value (`['entity', 'fields', 'email', 'type']`). To
 * show the issue where the author can act on it, that path has to become a
 * character range in the document, which means walking the parsed AST rather
 * than guessing at lines.
 *
 * Pure: no React, no DOM, no network. Unit-tested in `../__tests__`.
 */
import { isMap, isSeq, parseDocument } from 'yaml';
import type { Node, Pair } from 'yaml';
import type { ZodIssueLike } from '@studio-shared';

export interface IssueLocation {
  /** 1-based line, as the editor's gutter counts them. */
  line: number;
  /** 1-based column of `from`. */
  column: number;
  /** 0-based character offset, inclusive. */
  from: number;
  /** 0-based character offset, exclusive. */
  to: number;
}

export interface LocatedIssue {
  issue: ZodIssueLike;
  /** `undefined` when the document does not parse at all. */
  location?: IssueLocation;
  /**
   * The prefix of `issue.path` that exists in the document. Shorter than
   * `issue.path` when the issue is a missing key — then the location points at
   * the deepest ancestor that does exist, which is where the key belongs.
   */
  resolvedPath: (string | number)[];
  /** True when `resolvedPath` is the whole of `issue.path`. */
  exact: boolean;
}

/** Offsets of the first character of each line, ascending. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line and column for a 0-based offset. Binary search over `starts`. */
function positionAt(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 };
}

/** The pair in `node` whose key matches `segment`, if `node` is a map. */
function pairFor(node: unknown, segment: string | number): Pair<unknown, unknown> | undefined {
  if (!isMap(node)) return undefined;
  const wanted = String(segment);
  return node.items.find((pair) => {
    const key = pair.key as { value?: unknown } | null;
    return key != null && String(key.value) === wanted;
  });
}

interface Resolved {
  /** The node the range is taken from. */
  node: Node;
  /** How many segments of the path were consumed. */
  depth: number;
}

/**
 * Descend `path` from the document root, stopping at the deepest node that
 * exists.
 *
 * Two preferences make the resulting marker land where an author would look:
 *
 * - When the path is exhausted at a map entry whose value is a block, the
 *   *key* is returned. `fields.email` reads better underlined on `email:` than
 *   on the six lines it opens.
 * - When a segment does not exist — a missing required key, the common 422 —
 *   the key of the last block we descended through is returned, not that
 *   block's first line. A missing `fields.age.required` belongs on `age:`,
 *   which is the line the author has to add it under.
 */
function resolvePath(root: Node, path: (string | number)[]): Resolved {
  let current: Node = root;
  let depth = 0;
  /** The key of the block `current` lives in — where a missing child belongs. */
  let enclosingKey: Node | null = null;

  const stop = (): Resolved => ({
    node: enclosingKey != null && hasRange(enclosingKey) ? enclosingKey : current,
    depth,
  });

  for (const segment of path) {
    if (isSeq(current) && typeof segment === 'number') {
      const item = current.items[segment];
      if (item == null || typeof item !== 'object') return stop();
      current = item as Node;
      depth++;
      continue;
    }

    const pair = pairFor(current, segment);
    if (!pair) return stop();

    depth++;
    const key = pair.key as Node | null;
    const value = pair.value as Node | null;

    if (depth === path.length) {
      // Landed. A scalar value is the thing the message is about; a block is
      // better identified by the key that opens it.
      if (isScalarValue(value) && value != null && hasRange(value)) current = value;
      else if (key != null && hasRange(key)) current = key;
      else if (value != null) current = value;
      return { node: current, depth };
    }

    if (value == null || typeof value !== 'object') return stop();
    enclosingKey = key;
    current = value;
  }

  return { node: current, depth };
}

function hasRange(node: unknown): node is Node & { range: [number, number, number] } {
  return (
    typeof node === 'object' &&
    node !== null &&
    Array.isArray((node as { range?: unknown }).range)
  );
}

/** A scalar value is worth highlighting; a map or sequence block is not. */
function isScalarValue(node: unknown): boolean {
  return node != null && !isMap(node) && !isSeq(node);
}

/**
 * Resolve `path` from the root, then — if it matched nothing there — from
 * inside each top-level block.
 *
 * An entity file is `entity:` wrapping the body the schema describes, and a
 * 422 may report the path either way: `['entity','fields','title','type']` if
 * the server validated the whole document, `['fields','title','type']` if it
 * validated the body. Both have to land on the same line, and which one the
 * server sends is not something the editor should have to know.
 */
function resolveWithWrapper(root: Node, path: (string | number)[]): Resolved {
  const direct = resolvePath(root, path);
  if (direct.depth > 0 || path.length === 0 || !isMap(root)) return direct;

  for (const pair of root.items) {
    const value = pair.value as Node | null;
    if (value == null || typeof value !== 'object') continue;
    const nested = resolvePath(value, path);
    if (nested.depth > 0) return nested;
  }

  return direct;
}

/**
 * Resolve each issue to a range in `source`.
 *
 * Issues whose path does not exist — a missing required key is the common
 * case — resolve to their deepest existing ancestor and report `exact: false`,
 * so the caller can phrase the marker as "expected here" rather than
 * "wrong here". An unparseable document yields locations of `undefined`
 * rather than throwing: the editor still has to render the message.
 */
export function locateIssues(source: string, issues: ZodIssueLike[]): LocatedIssue[] {
  const doc = parseDocument(source, { keepSourceTokens: false });
  const root = doc.contents as Node | null;
  const starts = lineStarts(source);

  return issues.map((issue) => {
    if (root == null || !hasRange(root)) {
      return { issue, resolvedPath: [], exact: issue.path.length === 0 };
    }

    const { node, depth } = resolveWithWrapper(root, issue.path);
    const range = hasRange(node) ? node.range : undefined;
    if (!range) {
      return { issue, resolvedPath: issue.path.slice(0, depth), exact: depth === issue.path.length };
    }

    // `range` is [start, value-end, node-end]; the third includes trailing
    // comments and whitespace, so the second is the one to underline.
    const from = Math.min(range[0], source.length);
    const to = Math.max(Math.min(range[1], source.length), from + 1);
    const { line, column } = positionAt(starts, from);

    return {
      issue,
      location: { line, column, from, to },
      resolvedPath: issue.path.slice(0, depth),
      exact: depth === issue.path.length,
    };
  });
}

/** Human-readable `a.b[0].c` for an issue path. */
export function formatIssuePath(path: (string | number)[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    return acc ? `${acc}.${segment}` : segment;
  }, '');
}

/** The message to show on the marker, phrased by how well the path resolved. */
export function issueMessage(located: LocatedIssue): string {
  const where = formatIssuePath(located.issue.path);
  if (!where) return located.issue.message;
  if (located.exact) return `${where}: ${located.issue.message}`;
  return `${where}: ${located.issue.message} (expected here)`;
}
