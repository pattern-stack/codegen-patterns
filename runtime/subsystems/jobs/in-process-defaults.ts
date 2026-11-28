import type { InProcessKnobs } from '@pattern-stack/jobs/host';

/**
 * The in-process knobs every codegen host starts from, the one place (J-1): the Nest `JobsEngineModule` and the
 * pattern-stack `createJobsEngine` both spread these under the app's own. A run created in a caller's transaction
 * (the bridge's) is found by the open-run sweep: every 4 polls, a second at the default poll.
 */
export const IN_PROCESS_DEFAULTS: InProcessKnobs = { openSweepEvery: 4 };

export type { InProcessKnobs };
