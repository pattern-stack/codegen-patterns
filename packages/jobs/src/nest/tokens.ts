/**
 * The seams `@pattern-stack/jobs/nest` reads, each a `Symbol.for` token so it matches by value across import boundaries.
 *
 * Bound by the host (in a `@Global()` host module, so the package's module sees them):
 * - `JOBS_DRIZZLE`: the host's Drizzle database (`JobDatabase`, structural);
 * - `JOBS_TABLES`: the job tables, the package's own `jobTables` (`JobTables` is `typeof jobTables`);
 * - `JOBS_REDIS`: the host's Redis/Valkey client (`RedisEvalClient`: one `eval`; the host owns its lifecycle);
 * - `JOBS_QUEUE`: the host's registered BullMQ queue (`JobEngineQueue`);
 * - `JOBS_DEFINITIONS`: the jobs (`readonly AnyJob[]`);
 * - `JOBS_LIMITER_CONFIG`: each limiter name's config;
 * - `JOBS_TENANTS`: `{ findById(id) }`, so an operator start and ref options refuse an unknown tenant;
 * - `JOBS_EVENT_SINKS` (optional): the host's own sinks, run after the package's.
 *
 * Provided by the package: `JobsService` (a class), `JOBS_INPUT_REFS` (the registry the host's domains register into),
 * `JOBS_STORE` and `JOBS_EXECUTOR` (the worker's handlers), `JOBS_PUBLIC_CATALOG`, `JOBS_EVENTS` and `JOBS_CLOCK`.
 * `JOBS_REGISTRY` is exported for a host that starts runs inside its own transaction (codegen's bridge); `JOBS_OPERATOR_READS` is the package's own, unexported: a host reads the jobs through
 * `JobsService`.
 */
export const JOBS_DRIZZLE = Symbol.for('@pattern-stack/jobs.JOBS_DRIZZLE');
export const JOBS_TABLES = Symbol.for('@pattern-stack/jobs.JOBS_TABLES');
export const JOBS_REDIS = Symbol.for('@pattern-stack/jobs.JOBS_REDIS');
export const JOBS_QUEUE = Symbol.for('@pattern-stack/jobs.JOBS_QUEUE');
export const JOBS_DEFINITIONS = Symbol.for('@pattern-stack/jobs.JOBS_DEFINITIONS');
export const JOBS_LIMITER_CONFIG = Symbol.for('@pattern-stack/jobs.JOBS_LIMITER_CONFIG');
export const JOBS_TENANTS = Symbol.for('@pattern-stack/jobs.JOBS_TENANTS');
export const JOBS_EVENT_SINKS = Symbol.for('@pattern-stack/jobs.JOBS_EVENT_SINKS');

export const JOBS_INPUT_REFS = Symbol.for('@pattern-stack/jobs.JOBS_INPUT_REFS');
export const JOBS_REGISTRY = Symbol.for('@pattern-stack/jobs.JOBS_REGISTRY');
export const JOBS_STORE = Symbol.for('@pattern-stack/jobs.JOBS_STORE');
export const JOBS_OPERATOR_READS = Symbol.for('@pattern-stack/jobs.JOBS_OPERATOR_READS');
export const JOBS_EXECUTOR = Symbol.for('@pattern-stack/jobs.JOBS_EXECUTOR');
export const JOBS_PUBLIC_CATALOG = Symbol.for('@pattern-stack/jobs.JOBS_PUBLIC_CATALOG');
export const JOBS_EVENTS = Symbol.for('@pattern-stack/jobs.JOBS_EVENTS');
export const JOBS_CLOCK = Symbol.for('@pattern-stack/jobs.JOBS_CLOCK');

/**
 * Optional, bound by the host: the `RunScope` the in-process executor and `JobsService` wrap job code in (codegen binds
 * one that enters its repositories' tenant scope).
 */
export const JOBS_RUN_SCOPE = Symbol.for('@pattern-stack/jobs.JOBS_RUN_SCOPE');
/** The package's: whether this process starts the in-process executor's loop (`JobsModule.forRoot({ worker })`). */
export const JOBS_WORKER = Symbol.for('@pattern-stack/jobs.JOBS_WORKER');

/** The package's internal providers: the sink list and the limiters. */
export const JOBS_ENGINE_SINKS = Symbol.for('@pattern-stack/jobs.JOBS_ENGINE_SINKS');
export const JOBS_ENGINE_LIMITERS = Symbol.for('@pattern-stack/jobs.JOBS_ENGINE_LIMITERS');

/** The tenants a host hands in: enough to refuse an unknown one. */
export interface JobsTenants {
  findById(id: string): Promise<object | null>;
}
