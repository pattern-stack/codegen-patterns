import type { SweepCursorName, SweepCursors } from '../ports/sweep-cursors.ts';

/** Sweep cursors in memory: one process's own, right for a single process, tests and scripts. */
export function memorySweepCursors(): SweepCursors {
  const at = new Map<SweepCursorName, string>();
  return {
    async get(name) {
      return at.get(name);
    },
    async set(name, after) {
      if (after === undefined) at.delete(name);
      else at.set(name, after);
    },
  };
}
