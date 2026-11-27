/**
 * A write the database refused because of a constraint the request broke — the caller's mistake, not the server's.
 * Framework-free: nothing here imports Nest, so every HTTP layer (the Nest filter in `nest-db-constraint-filter.ts`,
 * a plain/Hono layer) answers with the same body.
 *
 * | Postgres | When | Status | `code` |
 * |---|---|---|---|
 * | 23503 on insert / update | a foreign key names no row (`projectId` = an id that isn't a project) | 422 | `foreign_key_violation` |
 * | 23503 on delete | the row is still referenced (a `restrict` FK) | 409 | `still_referenced` |
 * | 23505 | a unique constraint already has the value | 409 | `unique_violation` |
 *
 * The body has the shape of every error body the generated code sends — `{ statusCode, error, code, ...details,
 * message }`, Nest's key order (PW-0's `errorBody`) — with two details: `fields`, the request's property names (the
 * columns camelCased, as the generated DTOs name them; several are comma-separated), and `constraint`, the
 * constraint's name.
 *
 * The error arrives wrapped (Drizzle's `DrizzleQueryError` has the driver's error as its `cause`), and a class
 * check would miss a second copy of either package, so it is found by shape: the first error in the `cause` chain
 * whose `code` is one of the three.
 */

/** The reason phrase Nest prints for each status this module answers with. */
const REASONS = {
  409: 'Conflict',
  422: 'Unprocessable Entity',
} as const;

export type ConstraintViolationStatus = keyof typeof REASONS;
export type ConstraintViolationCode = 'foreign_key_violation' | 'still_referenced' | 'unique_violation';

export interface ConstraintViolation {
  readonly status: ConstraintViolationStatus;
  readonly code: ConstraintViolationCode;
  /** The request's property names for the constraint's columns, in the constraint's order. */
  readonly fields: readonly string[];
  /** The constraint's name, when the database gave one. */
  readonly constraint: string | null;
  readonly message: string;
}

/** The response body — the same keys, in the same order, as every other generated error body. */
export interface ConstraintViolationBody {
  readonly statusCode: ConstraintViolationStatus;
  readonly error: string;
  readonly code: ConstraintViolationCode;
  readonly fields: string;
  readonly constraint: string | null;
  readonly message: string;
}

/** The driver error's keys this reads (node-postgres and postgres.js both carry them). */
interface PgErrorShape {
  readonly code: string;
  readonly constraint?: string;
  readonly detail?: string;
  readonly table?: string;
  readonly table_name?: string;
  readonly constraint_name?: string;
}

const CODES = new Set(['23503', '23505']);

function driverError(err: unknown): PgErrorShape | null {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && CODES.has(code)) return current as PgErrorShape;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** `project_id` → `projectId`: the generated DTOs' property for a column. */
function propertyOf(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `Key (tenant_id, name)=(t1, Apollo) …` → columns and the value text. */
function parseKey(detail: string | undefined): { columns: string[]; values: string } | null {
  if (!detail) return null;
  const m = /^Key \((.+?)\)=\((.*)\) /.exec(detail);
  if (!m) return null;
  return { columns: m[1]!.split(',').map((c) => c.trim().replace(/^"|"$/g, '')), values: m[2]! };
}

/** The referenced table a 23503 detail names: `… is not present in table "projects".` / `… from table "tasks".` */
function tableIn(detail: string | undefined): string | null {
  const m = detail ? /table "([^"]+)"/.exec(detail) : null;
  return m ? m[1]! : null;
}

/** The violation `err` reports, or `null` when it is not a foreign-key or unique violation. */
export function constraintViolationOf(err: unknown): ConstraintViolation | null {
  const pg = driverError(err);
  if (pg === null) return null;
  const constraint = pg.constraint ?? pg.constraint_name ?? null;
  const key = parseKey(pg.detail);
  const fields = key ? key.columns.map(propertyOf) : [];
  const named = fields.length > 0 ? fields.join(', ') : 'a field';
  const suffix = constraint ? ` (constraint ${constraint})` : '';

  if (pg.code === '23505') {
    return {
      status: 409,
      code: 'unique_violation',
      fields,
      constraint,
      message: key
        ? `${named} ${fields.length > 1 ? 'are' : 'is'} already taken: (${key.values}) already exists${suffix}.`
        : `A unique value is already taken${suffix}.`,
    };
  }

  // 23503: on insert/update the key names no row; on delete the row is still referenced.
  const otherTable = tableIn(pg.detail);
  if (pg.detail?.includes('is still referenced from table')) {
    return {
      status: 409,
      code: 'still_referenced',
      fields,
      constraint,
      message:
        `This row is still referenced from ${otherTable ?? 'another table'}${suffix}: ` +
        `delete or reassign those rows first.`,
    };
  }
  return {
    status: 422,
    code: 'foreign_key_violation',
    fields,
    constraint,
    message: key
      ? `${named} ${key.values} does not name an existing ${otherTable ?? 'row'} row${suffix}.`
      : `A foreign key names no existing row${suffix}.`,
  };
}

export function constraintViolationBody(v: ConstraintViolation): ConstraintViolationBody {
  return {
    statusCode: v.status,
    error: REASONS[v.status],
    code: v.code,
    fields: v.fields.join(','),
    constraint: v.constraint,
    message: v.message,
  };
}
