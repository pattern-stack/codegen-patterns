/**
 * Injection tokens for the job orchestration domain layer (ADR-022, JOB-2).
 *
 * Consumer code injects these symbols via `@Inject(JOB_ORCHESTRATOR)` etc.;
 * concrete backends (JOB-3 Drizzle, JOB-4 Memory) provide the implementations
 * through `JobsDomainModule.forRoot({ backend })` in JOB-5.
 *
 * Each token is a namespaced `Symbol.for(...)` (ADR-037) — distinct per key, so
 * Nest's DI lookup is unambiguous, AND matching by VALUE across import
 * boundaries so the package and a (legacy) vendored runtime copy resolve to the
 * same symbol.
 * TODO(token-version): revisit embedding a contract version once codegen/surface
 * versioning is settled.
 */
export const JOB_ORCHESTRATOR = Symbol.for('@pattern-stack/codegen.jobs.orchestrator');
export const JOB_RUN_SERVICE = Symbol.for('@pattern-stack/codegen.jobs.run-service');
export const JOB_STEP_SERVICE = Symbol.for('@pattern-stack/codegen.jobs.step-service');

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
export const JOBS_MULTI_TENANT = Symbol.for('@pattern-stack/codegen.jobs.multi-tenant');
