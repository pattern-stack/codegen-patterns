/**
 * The jobs API's words and bounds. `packages/shared` can't import `@pattern-stack/jobs` without pulling it into the browser's
 * dependency graph, so the engine's lists are restated here; the backend's run view holds them equal at compile time.
 */

/** A run's statuses (`@pattern-stack/jobs` `RunStatus`). */
export const RUN_STATUSES = [
  'queued',
  'pending',
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'canceled',
] as const;
/** Why a run paused (`@pattern-stack/jobs` `PauseReason`). */
export const PAUSE_REASONS = [
  'budget',
  'deadline',
  'operator',
  'parent',
] as const;
/** What started a run (`@pattern-stack/jobs` `RunTrigger`). */
export const RUN_TRIGGERS = ['manual', 'eval', 'agent', 'schedule', 'event'] as const;
/** The triggers a caller may name; 'schedule' is the scheduler's, 'event' the event bridge's. */
export const CALLER_RUN_TRIGGERS = ['manual', 'eval', 'agent'] as const;
/** A step's statuses (`@pattern-stack/jobs` `StepStatus`). */
export const STEP_STATUSES = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'skipped',
] as const;
/** What a waiting step waits on (`@pattern-stack/jobs` `WaitKind`). */
export const WAIT_KINDS = ['children', 'signal', 'gate'] as const;
/**
 * How a run treats the result cache (`@pattern-stack/jobs` `CacheMode`): `read-write` reuses stored answers, `refresh` re-asks
 * every item and overwrites them with its own.
 */
export const CACHE_MODES = ['read-write', 'refresh'] as const;
/** A plain step or a map step. */
export const STEP_KINDS = ['step', 'map', 'wait', 'children'] as const;
/** A limiter's bucket: one for every run, or one per tenant (`@pattern-stack/jobs` `StepLimiter['per']`). */
export const LIMITER_SCOPES = ['global', 'tenant'] as const;
/** Who may do something with a job's runs, lowest first (`@pattern-stack/jobs` `JOB_AUTHORITY_LEVELS`). */
export const JOB_AUTHORITY_LEVELS = ['member', 'tenant-wide', 'admin'] as const;

export const RUN_PAGE_DEFAULT = 20;
export const RUN_PAGE_MAX = 100;
export const RUN_WAIT_DEFAULT_MS = 30_000;
export const RUN_WAIT_MAX_MS = 45_000;

/** A dedupe key names the work, never content: keys reach logs. */
export const DEDUPE_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * A job's OpenAPI component base: `Jobs` and the key in PascalCase, each run of letters and digits one word
 * (`document.reindex` → `JobsDocumentReindex`, `play.catch-up` → `JobsPlayCatchUp`).
 */
export function jobComponentBase(jobKey: string): string {
  const words = jobKey.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return `Jobs${words.map((w) => w[0]?.toUpperCase() + w.slice(1)).join('')}`;
}
