/**
 * Skip-guard for scaffold integration tests.
 *
 * These tests require a pre-generated consumer scaffold (`@gen/*`, generated
 * family base classes under `@shared/base-classes/*`, event-bus drizzle
 * backend) plus a running Docker Postgres. They are orchestrated by
 * `bun run test:integration` (see test/scaffold/run-integration.ts), which
 * runs codegen, pushes the schema, and sets SCAFFOLD_INTEGRATION=1.
 *
 * When SCAFFOLD_INTEGRATION !== '1' (default `bun test` runs), the suites
 * export `d = describe.skip` and the beforeAll/afterAll/beforeEach no-op,
 * so the suites appear as intentional skips rather than import errors.
 */
import { describe } from 'bun:test';

export const SHOULD_RUN_SCAFFOLD = process.env.SCAFFOLD_INTEGRATION === '1';

// TODO(infra): when SHOULD_RUN_SCAFFOLD=false these suites are skipped.
// See test/scaffold/README.md for how to run them locally.
export const d = SHOULD_RUN_SCAFFOLD ? describe : describe.skip;
