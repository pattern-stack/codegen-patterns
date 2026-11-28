import { type RunStatus, TERMINAL_RUN } from '../model/run.ts';

/**
 * Whether a heartbeat aborts its chunk's in-flight calls (`ctx.signal`): only when the claim is lost or the run ended
 * (canceled or failed; a run the report doesn't name is gone too). A pause lets them finish: new calls are refused by
 * `reserve`, the calls in flight still hold their claim, land and write, and the chunk then yields. One rule for
 * every executor.
 */
export const abortsInFlight = (
  lost: boolean,
  status: RunStatus | undefined,
): boolean => lost || status === undefined || TERMINAL_RUN.includes(status);
