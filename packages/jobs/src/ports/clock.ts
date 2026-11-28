/** Time, as the engine reads it: through this port only, so tests (and a replaying workflow) control it. */
export interface Clock {
  now(): Date;
  /** Waits `ms`, or rejects with the signal's reason once it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
