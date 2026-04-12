/**
 * Shared Drizzle type definitions.
 * DrizzleClient is used by generated repositories as the db parameter type.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleClient = NodePgDatabase<any>;
