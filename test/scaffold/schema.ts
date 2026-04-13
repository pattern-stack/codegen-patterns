/**
 * Drizzle schema for the scaffold test harness.
 *
 * Re-exports the contacts table from codegen output so that:
 *   1. drizzle-kit push can create the contacts table in Docker Postgres
 *   2. DatabaseModule can pass the schema to drizzle() for typed queries
 *
 * The import path uses the @gen alias (maps to repo root via tsconfig.json).
 * After running codegen, the entity file lives at:
 *   <repo-root>/modules/contacts/contact.entity.ts
 */
export { contacts } from '@gen/modules/contacts/contact.entity';
