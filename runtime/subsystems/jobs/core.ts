/**
 * The jobs subsystem's Nest-free entry (J-1): `@pattern-stack/jobs` wired into a generated app with no framework. The
 * engine builder (the `jobs` system calls it), the start entry point, the tenant scope, and the job tables
 * re-exported for the app's schema barrel (so its migrations create them). `index.ts` adds the Nest host.
 */
export { createJobsEngine, type JobsEngine, type CreateJobsEngineOptions } from './jobs-engine';
export { JobRunStarter, type JobRunStarterParts, type JobStartOptions } from './job-run-starter';
export { tenantRunScope } from './tenant-run-scope';
export * from '@pattern-stack/jobs/schema';
