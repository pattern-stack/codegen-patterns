/**
 * The jobs subsystem (JOBS-3): `@pattern-stack/jobs` wired into a generated app. Jobs themselves are `defineJob`
 * values (import them from `@pattern-stack/jobs`); this is the app's side: the Nest-free core (`./core`: the engine
 * builder, the start entry point, the tenant scope, the job tables) and the Nest host (the module and `JobStarter`).
 */
export * from './core';
export { JobsEngineModule, type JobsEngineOptions, JobsService } from './jobs-engine.module';
export { JobStarter } from './job-starter';
