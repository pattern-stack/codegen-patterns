import type { RunTrigger } from '../model/run.ts';
/**
 * The jobs API's words and bounds. The engine's word lists are declared once, in the model, and re-exported here: the
 * shapes live in the same package (core, beside `model/` and `define/`), so nothing is restated.
 */
export { JOB_AUTHORITY_LEVELS } from '../define/facts.ts';
export { LIMITER_SCOPES } from '../define/limits.ts';
export { CACHE_MODES, PAUSE_REASONS, RUN_STATUSES, RUN_TRIGGERS } from '../model/run.ts';
export { STEP_KINDS, STEP_STATUSES, WAIT_KINDS } from '../model/step-state.ts';

/** The triggers a caller may name; 'schedule' is the scheduler's, 'event' the event bridge's. */
export const CALLER_RUN_TRIGGERS = ['manual', 'eval', 'agent'] as const satisfies readonly RunTrigger[];

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
