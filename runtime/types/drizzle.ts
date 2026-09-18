/**
 * DrizzleClient type alias
 *
 * Type alias for the Drizzle ORM database client. Using NodePgDatabase
 * as the canonical Drizzle Postgres client type.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * The Drizzle database client type used throughout the runtime.
 *
 * Drizzle 1.0's generic slot is the RELATIONS MANIFEST (`defineRelations()`),
 * not the table schema — and this package is published, so it can never see a
 * consumer's manifest. Hence two handles on one object (ADR-044, REL-1):
 *
 *  - the runtime (this alias) holds the relations-agnostic form. A concrete
 *    `NodePgDatabase<typeof relations>` widens to it, so the very instance a
 *    generated project injects under `DRIZZLE` satisfies both;
 *  - generated code reaches the TYPED handle through generated code —
 *    `DrizzleDB` in the emitted `src/shared/database/database.module.ts`, which
 *    is `NodePgDatabase<typeof relations>` over the generated manifest.
 *
 * The parameter is here so a generated subclass can bind its own manifest
 * without this file ever importing generated code.
 */
export type DrizzleClient<TRelations extends AnyRelations = AnyRelations> =
	NodePgDatabase<TRelations>;

/**
 * A transaction-capable Drizzle handle. Structurally compatible with
 * DrizzleClient — either the root client or a tx callback handle from
 * `db.transaction((tx) => ...)` satisfies it, so writes can run in a
 * caller-owned transaction without changing repository internals.
 */
export type DrizzleTx = DrizzleClient;
