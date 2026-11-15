/**
 * Joined-table inheritance — the read helpers (RFC-0006 §3, §6; #875).
 *
 * A child entity (`inherits: communication`) is two rows sharing one id: the
 * base's and the child's. The generated repositories read them as ONE statement
 * on RQBv2 — the base is a relation, a child is a relation — and these two pure
 * functions shape the result. There is no second query path here: `columns`,
 * `with`, the scope and the one-statement rule all belong to the read that
 * produced the row.
 */

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
