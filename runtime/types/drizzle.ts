/**
 * DrizzleClient type alias
 *
 * Type alias for the Drizzle ORM database client. Using NodePgDatabase
 * as the canonical Drizzle Postgres client type.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * The Drizzle database client type used throughout the application.
 * Typed with a permissive schema to allow use in the abstract base class
 * without coupling to a specific schema module.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleClient = NodePgDatabase<any>;

/**
 * A transaction-capable Drizzle handle. Structurally compatible with
 * DrizzleClient — either the root client or a tx callback handle from
 * `db.transaction((tx) => ...)` satisfies it, so writes can run in a
 * caller-owned transaction without changing repository internals.
 */
export type DrizzleTx = DrizzleClient;
