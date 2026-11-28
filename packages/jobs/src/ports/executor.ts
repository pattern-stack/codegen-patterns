/**
 * Where runs are driven. In-process claims chunks itself; BullMQ dispatches them to workers; Temporal would start a
 * workflow. Claims, heartbeats and retries belong here, never in the engine. At most one advancer per run at a time;
 * the executor guarantees it.
 */
export interface Executor {
  /** Makes a run's work eligible: advances its steps and dispatches its map steps' chunks. */
  submit(runId: string): Promise<void>;
  /** Workers, heartbeat, sweeper. */
  start(): Promise<void>;
  /** drain (default): let in-flight chunks settle. Otherwise abort them and give back only this executor's claims. */
  stop(options?: { drain?: boolean }): Promise<void>;
}
