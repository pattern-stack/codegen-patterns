/**
 * Where a step's durable output lives when it is too big for the run's own record: the job kind's own tables (a
 * calibration band as rows of observation id and match), never a JSON column. A step without one records its small
 * output through the store.
 */
export interface StepRecorder<O> {
  save(runId: string, output: O): Promise<void>;
  /** undefined when nothing was saved for the run. */
  load(runId: string): Promise<O | undefined>;
}
