/**
 * Where a sweep's pages left off, shared by every process that sweeps: the sweep is one scheduled job that lands on any
 * worker, so a cursor one process keeps advances only on its own sweeps and starts over when it restarts. `open` is
 * the open runs' page, `due` the due waits'. `undefined` starts from the first run.
 */
export interface SweepCursors {
  get(name: SweepCursorName): Promise<string | undefined>;
  set(name: SweepCursorName, after: string | undefined): Promise<void>;
}

export type SweepCursorName = 'open' | 'due';
