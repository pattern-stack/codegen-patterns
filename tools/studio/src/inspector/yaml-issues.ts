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
  /**
   * The issue is about the file rather than a place in it — nothing in the
   * document corresponds to it. Such an issue has no `location`: pointing at
   * line 1 because that is where the root node starts would claim a precision
   * this does not have, and the reader would go looking there.
   */
  fileLevel: boolean;
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
 * Descend `path` through map *values* only, returning the container it names.
 *
 * `resolvePath` prefers the key when a path lands on a map entry, which is what
 * a schema issue wants. Locating an unrecognized key wants the opposite: the
 * map the key sits in, so the key's own node can be taken from it.
 */
function containerFor(root: Node, path: (string | number)[]): Node | undefined {
  let current: Node = root;

  for (const segment of path) {
    if (isSeq(current) && typeof segment === 'number') {
      const item = current.items[segment];
      if (item == null || typeof item !== 'object') return undefined;
      current = item as Node;
      continue;
    }
    const pair = pairFor(current, segment);
    const value = pair?.value as Node | null | undefined;
    if (value == null || typeof value !== 'object') return undefined;
    current = value;
  }

  return current;
}

/**
 * The node of `key` inside the map at `path` — the key, not its value.
 *
 * Tries the path as given, then inside each top-level block, for the same
 * reason `resolveWithWrapper` does: a 422 may or may not include the file's
 * `entity:` wrapper in its path.
 */
function keyNodeAt(root: Node, path: (string | number)[], key: string): Node | undefined {
  const candidates: (Node | undefined)[] = [containerFor(root, path)];

  if (isMap(root)) {
    for (const pair of root.items) {
      const value = pair.value as Node | null;
      if (value != null && typeof value === 'object') candidates.push(containerFor(value, path));
    }
  }

  for (const container of candidates) {
    if (container == null) continue;
    const node = pairFor(container, key)?.key as Node | null | undefined;
    if (node != null && hasRange(node)) return node;
  }

  return undefined;
}

/**
 * A node's range as an editor location.
 *
 * `range` is [start, value-end, node-end]; the third includes trailing comments
 * and whitespace, so the second is the one to underline.
 */
function locationOf(
  range: [number, number, number],
  starts: number[],
  source: string,
): IssueLocation {
  const from = Math.min(range[0], source.length);
  const to = Math.max(Math.min(range[1], source.length), from + 1);
  const { line, column } = positionAt(starts, from);
  return { line, column, from, to };
}

/** The document root's own location, for an issue that resolved nowhere else. */
function rootLocation(node: Node, starts: number[], source: string): IssueLocation | undefined {
  return hasRange(node) ? locationOf(node.range, starts, source) : undefined;
}

/**
 * The keys named by an `unrecognized_keys` issue.
 *
 * Zod reports the offending keys in `ZodIssue.keys`, which the contract's
 * `ZodIssueLike` does not carry, and puts `path` at the *object* — empty for a
 * key at the top level. The names survive in the message, so read them from
 * there: an author who typed a key that is not in the schema wants the marker
 * on that key, not on the first line of the file.
 */
const UNRECOGNIZED_KEYS = /Unrecognized key(?:\(s\))? in object:\s*(.+)$/;

function unrecognizedKeys(issue: ZodIssueLike): string[] {
  if (issue.code !== 'unrecognized_keys') return [];
  const match = UNRECOGNIZED_KEYS.exec(issue.message.trim());
  if (!match) return [];
  return [...match[1]!.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
}

/**
 * A position carried in the message text rather than in `path`.
 *
 * The most common 422 on a hand-edited file is not a schema violation at all —
 * it is a YAML parse failure, which the server reports with an empty `path` and
 * the position inside the message ("… at line 21, column 1"). Resolving an
 * empty path lands on the document root, which points at line 1 and is
 * actively misleading when the real problem is twenty lines down.
 */
const POSITION_IN_MESSAGE = /\bat line (\d+), column (\d+)/;

function positionFromMessage(
  message: string,
  starts: number[],
  source: string,
): IssueLocation | undefined {
  const match = POSITION_IN_MESSAGE.exec(message);
  if (!match) return undefined;

  const line = Number(match[1]);
  const column = Number(match[2]);
  const start = starts[line - 1];
  if (start === undefined) return undefined;

  const from = Math.min(start + column - 1, source.length);
  const lineEnd = starts[line] !== undefined ? starts[line]! - 1 : source.length;
  return { line, column, from, to: Math.max(lineEnd, from + 1) };
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
    // A parse failure has no path to resolve and a document that may not have
    // parsed at all, so its own reported position is the only thing to go on.
    if (issue.path.length === 0) {
      const fromMessage = positionFromMessage(issue.message, starts, source);
      if (fromMessage) {
        return { issue, location: fromMessage, resolvedPath: [], exact: true, fileLevel: false };
      }
    }

    if (root == null || !hasRange(root)) {
      return { issue, resolvedPath: [], exact: issue.path.length === 0, fileLevel: true };
    }

    // An unrecognized key is named in the message, not in the path, and it is
    // the key rather than its value that is wrong.
    for (const key of unrecognizedKeys(issue)) {
      const node = keyNodeAt(root, issue.path, key);
      if (node != null && hasRange(node)) {
        return {
          issue,
          location: locationOf(node.range, starts, source),
          resolvedPath: [...issue.path, key],
          exact: true,
          fileLevel: false,
        };
      }
    }

    const { node, depth } = resolveWithWrapper(root, issue.path);

    // Nothing in the document answers to this issue. Say so, rather than
    // pointing at the root node's first line as though it were the place.
    if (depth === 0 && issue.path.length > 0) {
      return { issue, resolvedPath: [], exact: false, fileLevel: false, location: rootLocation(node, starts, source) };
    }
    if (issue.path.length === 0) {
      return { issue, resolvedPath: [], exact: false, fileLevel: true };
    }

    const range = hasRange(node) ? node.range : undefined;
    if (!range) {
      return {
        issue,
        resolvedPath: issue.path.slice(0, depth),
        exact: depth === issue.path.length,
        fileLevel: false,
      };
    }

    return {
      issue,
      location: locationOf(range, starts, source),
      resolvedPath: issue.path.slice(0, depth),
      exact: depth === issue.path.length,
      fileLevel: false,
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

/**
 * Collapse a message to one line.
 *
 * A YAML parse error's message embeds the offending snippet and a caret across
 * several lines. That reads well in a terminal and badly in a one-row list, so
 * the runs of whitespace become single spaces and the caret line goes.
 */
function oneLine(message: string): string {
  return message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^\^+$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The message to show on the marker, phrased by how well the path resolved. */
export function issueMessage(located: LocatedIssue): string {
  const message = oneLine(located.issue.message);
  // The issue's own path, not the resolved prefix: when a required key is
  // missing, its name is the thing the author needs, and the prefix has
  // dropped it. `resolvedPath` describes where the marker sits, not what is
  // wrong.
  const where = formatIssuePath(located.issue.path);
  if (!where) return message;
  if (located.exact) return `${where}: ${message}`;
  return `${where}: ${message} (expected here)`;
}

/** What the issue list shows in its position column. */
export function issuePosition(located: LocatedIssue): string {
  if (located.fileLevel) return 'file';
  if (!located.location) return '—';
  return `${located.location.line}:${located.location.column}`;
}
