/**
 * Injection tokens for the job orchestration domain layer (ADR-022, JOB-2).
 *
 * Consumer code injects these symbols via `@Inject(JOB_ORCHESTRATOR)` etc.;
 * concrete backends (JOB-3 Drizzle, JOB-4 Memory) provide the implementations
 * through `JobsDomainModule.forRoot({ backend })` in JOB-5.
 *
 * Each token is a unique `Symbol` — guaranteed distinct from every other
 * Symbol at runtime, which is exactly the uniqueness guarantee Nest's DI
 * container relies on for token-based lookup.
 */
export const JOB_ORCHESTRATOR = Symbol('JOB_ORCHESTRATOR');
export const JOB_RUN_SERVICE = Symbol('JOB_RUN_SERVICE');
export const JOB_STEP_SERVICE = Symbol('JOB_STEP_SERVICE');
