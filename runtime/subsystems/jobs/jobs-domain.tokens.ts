/**
 * Injection tokens for the job orchestration domain layer (ADR-022, JOB-2).
 *
 * Consumer code injects these symbols via `@Inject(JOB_ORCHESTRATOR)` etc.;
 * concrete backends (JOB-3 Drizzle, JOB-4 Memory) provide the implementations
 * through `JobsDomainModule.forRoot({ backend })` in JOB-5.
 *
 * Each token is a namespaced `Symbol.for(...)` (ADR-037, via `tokenKey()`) —
 * distinct per key, so Nest's DI lookup is unambiguous, AND matching by VALUE
 * across import boundaries so the package and a (legacy) vendored runtime copy
 * resolve to the same symbol.
 */
import { tokenKey } from '../token-key';

export const JOB_ORCHESTRATOR = Symbol.for(tokenKey('jobs', 'orchestrator'));
export const JOB_RUN_SERVICE = Symbol.for(tokenKey('jobs', 'run-service'));
export const JOB_STEP_SERVICE = Symbol.for(tokenKey('jobs', 'step-service'));

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
export const JOBS_MULTI_TENANT = Symbol.for(tokenKey('jobs', 'multi-tenant'));

/**
 * LISTEN/NOTIFY wakeup opt-in flag (LISTEN-NOTIFY-1). Bound to
 * `JobsDomainModule.forRoot({ extensions: { drizzle: { listenNotify } } })`,
 * defaulting to `false`.
 *
 * When `true`, the Drizzle orchestrator emits an in-transaction
 * `pg_notify(codegen_jobs_wake, <pool>)` on every `start()` INSERT so a worker
 * with `listen_notify` enabled wakes the moment the enqueue commits. Off by
 * default; polling is unchanged. The flag is read by `DrizzleJobOrchestrator`
 * and by the bridge outbox drain hook (its wrapper `job_run` inserts notify too).
 */
export const JOBS_LISTEN_NOTIFY = Symbol.for(tokenKey('jobs', 'listen-notify'));
