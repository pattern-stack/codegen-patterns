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

/**
 * Multi-tenancy opt-in flag (JOB-8). Bound to the boolean passed in via
 * `JobsDomainModule.forRoot({ multiTenant })`, defaulting to `false`.
 *
 * When `true`, the four service-layer backends (Drizzle + Memory orchestrator
 * and run-service) enforce `tenantId` on every mutating / targeted-read call:
 * `start`, `cancel`, `listForScope`, `cancelForScope`, `rescheduleForScope`.
 * Missing (`undefined`) `tenantId` throws `MissingTenantIdError`; explicit
 * `null` opts into cross-tenant background work and passes through.
 *
 * The JobWorker claim loop is **cross-tenant by design** — the worker has no
 * tenant context; `tenantId` is populated at write time and enforced on
 * targeted reads. See docs/specs/JOB-8.md.
 */
export const JOBS_MULTI_TENANT = Symbol('JOBS_MULTI_TENANT');
