/**
 * The jobs subsystem (JOBS-3): `@pattern-stack/jobs` wired into a generated Nest app. Jobs themselves are
 * `defineJob` values (import them from `@pattern-stack/jobs`); this is the app's side: the host module, the start entry
 * point, the tenant scope, and the job tables re-exported for the app's schema barrel (so its migrations create them).
 */
export { JobsEngineModule, type JobsEngineOptions, JobsService } from './jobs-engine.module';
export { JobStarter, type JobStartOptions } from './job-starter';
export { tenantRunScope } from './tenant-run-scope';
export * from '@pattern-stack/jobs/schema';
