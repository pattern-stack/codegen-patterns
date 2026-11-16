/**
 * Joined-table inheritance — the read helpers (RFC-0006 §3, §6; #875).
 *
 * A child entity (`inherits: communication`) is two rows sharing one id: the
 * base's and the child's. The generated repositories read them as ONE statement
 * on RQBv2 — the base is a relation, a child is a relation — and these two pure
 * functions shape the result. There is no second query path here: `columns`,
 * `with`, the scope and the one-statement rule all belong to the read that
 * produced the row.
 *
 * The WRITE half (RFC-0006 §4) lives here too: `splitByOwner`, `inTransaction`,
 * `upsertSet`, `assertBaseOnlyKind`, `fillDerivedColumns` and the errors the pair writes throw. The write itself is the child
 * repository's generated `create` / `update` / `delete` / `upsertByNaturalKey`;
 * these are the pure parts those methods share.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DrizzleClient, DrizzleTx } from '../types/drizzle';

/**
 * The row a flat read returns: the root minus its base relation, plus the base's columns.
 *
 * `K` is any key, not `keyof R`: a generated repository names it inside a generic
 * method (`MeetingFlat<W>`), where `R` is a deferred relational-query result and
 * `K extends keyof R` is TS2344 (measured). The conditional resolves once `R` is
 * concrete.
 */
export type Flattened<R, K extends PropertyKey> = Omit<R, K> & (K extends keyof R ? R[K] : never);

/**
 * Hoist a to-one relation's columns to the root. Pure; no query.
 *
 * `const flat = flattenBase(meeting, 'communication')` — `{ id, kind, title,
 * occurredAt, … }`. The base's columns win a name clash (there is none: R4
 * refuses a field both tables declare), and the base key itself is dropped.
 */
export function flattenBase<R extends Record<K, object>, K extends keyof R & string>(
  row: R,
  baseKey: K,
): Flattened<R, K> {
  const { [baseKey]: base, ...own } = row;
  return { ...own, ...base } as Flattened<R, K>;
}

/**
 * A base row was read for a kind that has a child table, but the child row is
 * missing: the base was inserted and the child never was. The database allows
 * it (the base is inserted first, RFC-0006 §2.2); the generated write path
 * prevents it and `findOrphans()` finds it. A read throws instead of returning a
 * half-typed row.
 */
export class OrphanBaseError extends Error {
  constructor(
    readonly id: string,
    readonly kind: string,
    readonly childKey: string,
  ) {
    super(
      `Orphan base row: ${id} has kind '${kind}', which has a child table, but no '${childKey}' row exists for it.`,
    );
    this.name = 'OrphanBaseError';
  }
}

/**
 * Narrow a base row read with its children to the discriminated union.
 *
 * `childKeyByKind` maps each kind that HAS a child table to the relation key the
 * read included it under (`{ meeting: 'meeting', email: 'email' }`). A base-only
 * kind is absent from the map and passes through bare. A kind in the map whose
 * child came back `null` (or absent) throws {@link OrphanBaseError}.
 *
 * "A null child is an orphan" is sound because R5 bars a child's own lifecycle axes and the child's tenant column is
 * pinned to its base's by a composite FK: a base row visible at the root always has its child visible at the hop.
 *
 * A child relation the read did not include (`findAllKinds({ kinds: ['meeting'] })`
 * joins only `meeting`) is never an orphan: the caller filtered to kinds it
 * joined, so every row's child key is present in the row.
 *
 * Pure: it does not read the database. The row's other children are removed so
 * each variant carries only its own kind's child.
 */
export function asKind<U>(
  row: object,
  discriminator: string,
  childKeyByKind: Readonly<Record<string, string>>,
): U {
  const record = row as Record<string, unknown>;
  const kind = record[discriminator];
  const out: Record<string, unknown> = { ...record };
  const ownChild = typeof kind === 'string' ? childKeyByKind[kind] : undefined;
  for (const childKey of Object.values(childKeyByKind)) {
    if (childKey !== ownChild) delete out[childKey];
  }
  if (ownChild !== undefined && (record[ownChild] === null || record[ownChild] === undefined)) {
    throw new OrphanBaseError(String(record['id']), String(kind), ownChild);
  }
  return out as U;
}

// ============================================================================
// Writes (RFC-0006 §4)
// ============================================================================

/**
 * An update tried to change a row's kind (RFC-0006 §4.1). A meeting does not
 * become an email: delete and create. The database refuses the same change for
 * any row that has a child (`ON UPDATE NO ACTION` on the kind FK); this names
 * the cause, and refuses it for a base-only kind too.
 */
export class KindImmutableError extends Error {
  constructor(readonly entity: string) {
    super(`${entity}: 'kind' is immutable. A row does not change kind — delete it and create the other one.`);
    this.name = 'KindImmutableError';
  }
}

/**
 * An upsert found a row with that natural key under ANOTHER kind (RFC-0006
 * §4.2). The write is refused — nothing is updated, whether or not the caller
 * owns the transaction.
 */
export class KindMismatchError extends Error {
  constructor(
    readonly entity: string,
    readonly expectedKind: string,
    detail = 'a row with this natural key already exists under another kind',
  ) {
    super(`${entity}: ${detail} (expected kind '${expectedKind}'). Nothing was written.`);
    this.name = 'KindMismatchError';
  }
}

/**
 * A write through the BASE named a kind that has a child table (RFC-0006 §4.1).
 * Only the child's own create path writes both rows; the base alone would leave
 * an orphan (§2.2).
 */
export class KindRequiresChildError extends Error {
  constructor(
    readonly entity: string,
    readonly kind: string,
    readonly createPath: string,
  ) {
    super(`${entity}: kind '${kind}' has a child table. Create it through ${createPath}, which writes both rows.`);
    this.name = 'KindRequiresChildError';
  }
}

/**
 * An update named a column the database derives from a parent row (a `match:`
 * column, RFC-0006 §2.4 / M4) without changing the foreign key it is derived
 * from. The value is never client input.
 */
export class MatchColumnImmutableError extends Error {
  constructor(
    readonly entity: string,
    readonly column: string,
    readonly foreignKey: string,
  ) {
    super(
      `${entity}: '${column}' is derived from '${foreignKey}' and cannot be set. ` +
        `It follows '${foreignKey}': change that and the repository re-derives it.`,
    );
    this.name = 'MatchColumnImmutableError';
  }
}

/**
 * An upsert found the row its natural key names, under the SAME kind, but the
 * ambient scope does not let this caller write it (the `user_tracking` axis:
 * another user's row, RFC-0006 §4.2). Nothing was written. There is no existing
 * error for this: a scoped `update()` simply matches no row and returns
 * `undefined`, which an upsert's `{ row, created }` result cannot express.
 */
export class OutOfScopeWriteError extends Error {
  constructor(readonly entity: string) {
    super(`${entity}: the row with this natural key exists but is outside the caller's scope (another user's). Nothing was written.`);
    this.name = 'OutOfScopeWriteError';
  }
}

/**
 * An `upsertByNaturalKey` input left a natural-key column NULL or absent (RFC-0006 §4.2, S7). A NULL never conflicts in
 * Postgres, so `ON CONFLICT` would insert a second row instead of updating the first: the upsert is refused before any
 * statement runs. The columns are the key's own, never the tenant's (the repository stamps that).
 */
export class NaturalKeyNullError extends Error {
  constructor(
    readonly entity: string,
    readonly columns: readonly string[],
  ) {
    super(`${entity}: upsertByNaturalKey needs a value for ${columns.map((c) => `'${c}'`).join(', ')} (null or absent). Nothing was written.`);
    this.name = 'NaturalKeyNullError';
  }
}

/**
 * The ONE owner of the NULL guard: throws `NaturalKeyNullError` naming every key column the input leaves null or
 * absent. A child's upsert runs its base's, so the guard covers both without a second copy.
 */
export function assertNaturalKeyValues(
  entity: string,
  input: Record<string, unknown>,
  keyProps: readonly string[],
): void {
  const missing = keyProps.filter((k) => input[k] === null || input[k] === undefined);
  if (missing.length > 0) throw new NaturalKeyNullError(entity, missing);
}

/**
 * Split a flat input into the base's slice and the child's. Pure.
 *
 * `baseKeys` are the base table's column keys. A key the base owns goes to
 * `base` (`id`, the kind and the tenant column too: the child carries those as
 * copies the base row supplies, so they are never written from the input).
 * Every other key is the child's own. An `undefined` value is dropped: it is an
 * absent key, not an instruction to clear.
 */
export function splitByOwner<T extends object>(
  input: T,
  baseKeys: ReadonlySet<string>,
): { base: Partial<T>; own: Partial<T> } {
  const base: Record<string, unknown> = {};
  const own: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    (baseKeys.has(key) ? base : own)[key] = value;
  }
  return { base: base as Partial<T>, own: own as Partial<T> };
}

/**
 * The pair writes' transaction rule: join the caller's transaction when one is
 * passed, otherwise open one. Both rows of a pair are written inside it, so a
 * failing child insert rolls the base row back.
 */
export function inTransaction<T>(
  db: DrizzleClient,
  tx: DrizzleTx | undefined,
  fn: (tx: DrizzleTx) => Promise<T>,
): Promise<T> {
  return tx ? fn(tx) : db.transaction((t) => fn(t as unknown as DrizzleTx));
}

/**
 * The `SET` of an upsert's `DO UPDATE` (RFC-0006 §4.2): the columns the input
 * carries, minus the ones an upsert never rewrites (`id`, the kind, the tenant
 * column, the natural key's columns, `created_at`). An absent key
 * (`undefined`) is left alone; an explicit `null` clears the column.
 */
export function upsertSet(
  input: Record<string, unknown>,
  never: ReadonlySet<string>,
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !never.has(key)) set[key] = value;
  }
  return set;
}

/**
 * The mark a child's pair write passes to its base's repository (`create` /
 * `upsertByNaturalKey`) to say "the child owns this write": the base then does
 * not refuse the child's own kind. A write that does not carry it is a write
 * through the base (RFC-0006 §4.1).
 */
export const PAIR_WRITE: unique symbol = Symbol('pair-write');
export type PairWrite = typeof PAIR_WRITE;

/**
 * Refuse a write through a BASE that names a kind with a child table
 * (RFC-0006 §4.1): `createPathByKind` maps each such kind to the create path
 * that writes both rows. A base-only kind (absent from the map) passes, and so
 * does a child's own pair write (`via === PAIR_WRITE`). The base repository is
 * the one owner of this rule — the service keeps no copy.
 */
export function assertBaseOnlyKind(
  entity: string,
  kind: unknown,
  createPathByKind: Readonly<Record<string, string>>,
  via?: PairWrite,
): void {
  if (via === PAIR_WRITE) return;
  if (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(createPathByKind, kind)) {
    throw new KindRequiresChildError(entity, kind, createPathByKind[kind]!);
  }
}

// ============================================================================
// `match:` — columns derived from a parent row (RFC-0006 §2.4)
// ============================================================================

/**
 * One parent a derived column can be read from: the foreign key to it (this
 * table's key and column), and the parent's primary key and the column whose
 * value is copied.
 */
export interface ParentSource {
  /** This table's foreign-key key (`communicationId`) … */
  readonly fkKey: string;
  /** … and its column, read when an update leaves the key alone. */
  readonly fkColumn: PgColumn;
  /** The parent table, and its primary-key column. */
  readonly parentTable: PgTable;
  readonly parentId: PgColumn;
  /** The parent's column the derived column copies. */
  readonly parentValue: PgColumn;
}

/** A column the database derives from its parents: `sources` in declaration order, the first that resolves wins. */
export interface DerivedColumn {
  readonly key: string;
  readonly sources: readonly ParentSource[];
}

/**
 * Fill each derived column with a scalar subquery on its parent's primary key,
 * in the SAME statement as the write (RFC-0006 §2.4):
 * `(select kind from communications where id = $1)`. Several relationships
 * matching one column are tried in declaration order (`coalesce`), so a column
 * shared by two nullable foreign keys is set when either is.
 *
 * `create` always derives (the value is never client input). `update`
 * re-derives only when the payload sets a foreign key the column follows — the
 * other keys are read from the row — and refuses a payload that names the column
 * itself without changing one (M4, {@link MatchColumnImmutableError}). A missing
 * parent derives NULL, which the column's NOT NULL (or the match CHECK) refuses.
 */
export function fillDerivedColumns(
  entity: string,
  data: Record<string, unknown>,
  mode: 'create' | 'update',
  derived: readonly DerivedColumn[],
): Record<string, unknown> {
  const out = { ...data };
  const set = (key: string) => data[key] !== undefined;
  for (const column of derived) {
    const followsChanged = column.sources.some((source) => set(source.fkKey));
    if (mode === 'update') {
      if (set(column.key) && !followsChanged) {
        throw new MatchColumnImmutableError(entity, column.key, column.sources[0]!.fkKey);
      }
      if (!followsChanged) continue;
    }
    const parts: SQL[] = column.sources.map((source) => {
      const id = set(source.fkKey) ? data[source.fkKey] : mode === 'update' ? source.fkColumn : null;
      return sql`(select ${source.parentValue} from ${source.parentTable} where ${source.parentId} = ${id})`;
    });
    out[column.key] = parts.length === 1 ? parts[0] : sql`coalesce(${sql.join(parts, sql`, `)})`;
  }
  return out;
}
