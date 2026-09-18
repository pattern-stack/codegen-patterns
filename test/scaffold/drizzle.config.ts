import { defineConfig } from 'drizzle-kit';
import { scaffoldDatabaseUrl } from './harness-env';

export default defineConfig({
  schema: './schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Falls back to this checkout's derived port, not a fixed 5432 — sibling
    // worktrees each publish their own (`harness-env.ts`).
    url: scaffoldDatabaseUrl(),
  },
});
