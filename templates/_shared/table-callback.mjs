/**
 * The parameter name of every emitted `pgTable` extra-config callback:
 * `(tCols) => [ index(...).on(tCols.x), ... ]`.
 *
 * ONE name for every table (#813): a function that reads a table export by
 * name declares no binding a plural could equal, and every plural is all-lowercase
 * snake_case, so a camelCase name can never collide. A composite FK reads the
 * OTHER table's export inside the callback, which is what made this a rule for
 * every table and not only for the ones that have one (RFC-0006, #875).
 *
 * Every builder that writes a column reference reads this constant — nothing
 * rewrites finished text, which would also rewrite a string literal in a
 * user's raw-SQL predicate.
 */
export const TABLE_CALLBACK_PARAM = 'tCols';
