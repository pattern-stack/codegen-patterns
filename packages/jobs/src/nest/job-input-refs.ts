import { Injectable } from '@nestjs/common';
import {
  JOB_REF_KIND_PATTERN,
  type JobRefKind,
  type JobsOpsRefOption,
  type JobsOpsViewRecord,
} from '../shapes/ops.ts';
import { z } from 'zod';

/** One option Start run's picker shows, and what `resolve` answers: `{ id, label, hint }`. */
export type JobInputRefOption = JobsOpsRefOption;

/**
 * One kind of domain id a job names, looked up by the context that owns it: in a job's input (`jobRef(kind)`), which
 * needs `listOptions`, and in a view's section (`refs`), which reads `resolve` alone.
 */
export interface JobInputRefSource {
  readonly kind: JobRefKind;
  /** What the kind is called: errors and logs say it. */
  readonly label: string;
  /**
   * Start run's picker: the tenant's live ones whose name holds `q` (any case), by name, at most `limit`. Absent
   * for a kind only views name: no input may name it, which the boot check enforces.
   */
  listOptions?(
    tenantId: string,
    q: string | undefined,
    limit: number,
  ): Promise<JobInputRefOption[]>;
  /** The names of these ids, read inside the tenant. An id it doesn't hold there is left out. */
  resolve(
    tenantId: string,
    ids: readonly string[],
  ): Promise<JobInputRefOption[]>;
}

/** What the host's domains register into, and `JobsService` reads: `JOBS_INPUT_REFS`, provided by the package. */
export interface JobInputRefs {
  /** A second source for a kind throws. */
  register(...sources: JobInputRefSource[]): void;
  sourceOf(kind: JobRefKind): JobInputRefSource | undefined;
}

/**
 * The registry, with no dependencies, so any module may inject it without closing a cycle. Each domain module that
 * owns a kind registers its source in its constructor; the lifecycle's boot check then proves every kind a registered
 * job names has one.
 */
@Injectable()
export class JobInputRefRegistry implements JobInputRefs {
  private readonly sources = new Map<JobRefKind, JobInputRefSource>();

  register(...sources: JobInputRefSource[]): void {
    for (const source of sources) {
      if (this.sources.has(source.kind))
        throw new Error(
          `a second JobInputRefSource was registered for ref kind ${source.kind}`,
        );
      this.sources.set(source.kind, source);
    }
  }

  sourceOf(kind: JobRefKind): JobInputRefSource | undefined {
    return this.sources.get(kind);
  }
}

/** Every list-backed source's filter: names holding the words (any case), by name, cut to the limit. */
export function matchingRefOptions<T>(
  rows: readonly T[],
  nameOf: (row: T) => string,
  q: string | undefined,
  limit: number,
): T[] {
  const words = (q ?? '').trim().toLowerCase();
  return rows
    .filter((row) => !words || nameOf(row).toLowerCase().includes(words))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
    .slice(0, limit);
}

/** What a view names by id: its sections' `refs` (`ItemView` and `StepView` share the shape). */
interface ViewWithRefs {
  detail?: readonly { refs?: { kind: string; ids: readonly string[] } }[];
}

/** Ids per `resolve` call: a bound list a source's `IN (…)` takes in one statement. */
const RESOLVE_BATCH = 1_000;

/**
 * The records each view names (its sections' `refs`), looked up in the run's tenant: one batched `resolve` per
 * kind for the whole page, then each view's own records, in the order it names them, each id once. An id the
 * tenant doesn't hold, or a kind with no registered source (or none this build knows), is left out: the page
 * shows it as not found. A source that fails fails the read, as any read does: it is never shown as not found.
 */
export async function viewRecordsOf(
  refs: JobInputRefs,
  tenantId: string,
  views: readonly (ViewWithRefs | null)[],
): Promise<JobsOpsViewRecord[][]> {
  const named = (view: ViewWithRefs | null) =>
    (view?.detail ?? []).flatMap((section) =>
      section.refs ? [section.refs] : [],
    );
  const wanted = new Map<JobRefKind, Set<string>>();
  for (const view of views)
    for (const { kind, ids } of named(view)) {
      if (!isRefKind(kind) || !refs.sourceOf(kind)) continue;
      const set = wanted.get(kind) ?? new Set<string>();
      for (const id of ids) set.add(id);
      wanted.set(kind, set);
    }
  const found = new Map<string, JobsOpsViewRecord>();
  const at = (kind: string, id: string) => `${kind}:${id}`;
  for (const [kind, set] of wanted) {
    const source = refs.sourceOf(kind);
    if (!source) continue;
    const ids = [...set];
    for (let from = 0; from < ids.length; from += RESOLVE_BATCH)
      for (const option of await source.resolve(
        tenantId,
        ids.slice(from, from + RESOLVE_BATCH),
      ))
        if (set.has(option.id))
          found.set(at(kind, option.id), {
            kind,
            id: option.id,
            label: option.label,
            hint: option.hint,
          });
  }
  return views.map((view) => {
    const seen = new Set<string>();
    const records: JobsOpsViewRecord[] = [];
    for (const { kind, ids } of named(view))
      for (const id of ids) {
        const record = found.get(at(kind, id));
        if (!record || seen.has(at(kind, id))) continue;
        seen.add(at(kind, id));
        records.push(record);
      }
    return records;
  });
}

/** A `ref` field of a job's input: its path (`a.b`, `ids[]` for each item of a list), its kind, and whether it is a list. */
export interface JobInputRefField {
  path: string;
  kind: JobRefKind;
  many: boolean;
}

const isRefKind = (value: unknown): value is JobRefKind =>
  typeof value === 'string' && JOB_REF_KIND_PATTERN.test(value);

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Segments: a property name, or `[]` for every item of a list. */
type Segment = string;

function walk(
  node: unknown,
  at: Segment[],
  defs: Node,
  out: { at: Segment[]; kind: JobRefKind; many: boolean }[],
  seen: Set<string>,
): void {
  if (!isNode(node)) return;
  if (typeof node.$ref === 'string') {
    const name = node.$ref.replace(/^#\/(\$defs|definitions)\//, '');
    if (seen.has(name)) return;
    walk(defs[name], at, defs, out, new Set([...seen, name]));
    return;
  }
  if (isRefKind(node.ref)) {
    const many = at.includes('[]');
    out.push({ at, kind: node.ref, many });
    return;
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const options = node[key];
    if (Array.isArray(options))
      for (const option of options) walk(option, at, defs, out, seen);
  }
  if (isNode(node.properties))
    for (const [name, child] of Object.entries(node.properties))
      walk(child, [...at, name], defs, out, seen);
  if (node.items !== undefined)
    walk(node.items, [...at, '[]'], defs, out, seen);
}

/**
 * The `ref` fields of a job's input: its JSON Schema's `ref` keywords (`jobRef`), nested ones and lists included, each
 * with its path. Read once per job, at boot and per start.
 */
export function refFieldsOf(input: z.ZodType): readonly JobInputRefField[] {
  return refSegmentsOf(input).map(({ at, kind, many }) => ({
    path: pathOf(at),
    kind,
    many,
  }));
}

const pathOf = (at: readonly Segment[]): string =>
  at.join('.').replaceAll('.[]', '[]');

/** The schema's named definitions, under either keyword zod may emit. */
function defsOf(schema: Node): Node {
  if (isNode(schema.$defs)) return schema.$defs;
  if (isNode(schema.definitions)) return schema.definitions;
  return {};
}

function refSegmentsOf(
  input: z.ZodType,
): { at: Segment[]; kind: JobRefKind; many: boolean }[] {
  let schema: Node;
  try {
    schema = z.toJSONSchema(input, {
      io: 'input',
      unrepresentable: 'any',
    }) as Node;
  } catch {
    return [];
  }
  const defs = defsOf(schema);
  const out: { at: Segment[]; kind: JobRefKind; many: boolean }[] = [];
  walk(schema, [], defs, out, new Set());
  return out;
}

/** Pushes the strings `value` holds at the path `rest` onto `ids`; an absent or mistyped step holds none. */
function collectIds(value: unknown, rest: readonly Segment[], ids: string[]) {
  if (value === undefined || value === null) return;
  const [head, ...tail] = rest;
  if (head === undefined) {
    if (typeof value === 'string') ids.push(value);
    return;
  }
  if (head !== '[]') {
    if (isNode(value)) collectIds(value[head], tail, ids);
    return;
  }
  if (Array.isArray(value))
    for (const item of value) collectIds(item, tail, ids);
}

/** The ids a parsed input holds at each ref field, by field. Absent and null values are left out. */
export function refValuesOf(
  input: z.ZodType,
  value: unknown,
): { field: JobInputRefField; ids: string[] }[] {
  return refSegmentsOf(input).map(({ at, kind, many }) => {
    const ids: string[] = [];
    collectIds(value, at, ids);
    return {
      field: { path: pathOf(at), kind, many },
      ids: [...new Set(ids)],
    };
  });
}
