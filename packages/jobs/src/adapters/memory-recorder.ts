import type {
  RecordedResult,
  ResultRecorder,
} from '../ports/result-recorder.ts';
import type { StepRecorder } from '../ports/step-recorder.ts';

/** A step recorder in memory, for tests and scripts: one output per run, a copy in and a copy out. */
export function memoryRecorder<O>(): StepRecorder<O> & {
  readonly saved: ReadonlyMap<string, O>;
} {
  const saved = new Map<string, O>();
  return {
    saved,
    async save(runId, output) {
      saved.set(runId, structuredClone(output));
    },
    async load(runId) {
      const output = saved.get(runId);
      return output === undefined ? undefined : structuredClone(output);
    },
  };
}

/** A result recorder in memory, for tests and scripts: the first write per tenant and key wins. */
export function memoryResultRecorder<R>(): ResultRecorder<R> & {
  /** What was saved, by tenant and key, with its producing run. */
  readonly saved: ReadonlyMap<string, RecordedResult<R> & { runId: string }>;
} {
  const saved = new Map<string, RecordedResult<R> & { runId: string }>();
  const at = (tenantId: string, key: string) =>
    `${tenantId}\u0000${key}`;
  return {
    saved,
    async save(tenantId, runId, results) {
      for (const r of results)
        if (!saved.has(at(tenantId, r.key)))
          saved.set(at(tenantId, r.key), {
            ...structuredClone(r),
            runId,
          });
    },
    async load(tenantId, keys) {
      const out = new Map<string, RecordedResult<R>>();
      for (const key of keys) {
        const hit = saved.get(at(tenantId, key));
        if (hit)
          out.set(key, {
            key: hit.key,
            ref: hit.ref,
            result: structuredClone(hit.result),
          });
      }
      return out;
    },
  };
}
