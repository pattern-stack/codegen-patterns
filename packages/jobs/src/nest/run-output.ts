import { z } from 'zod';
import {
  JobDefinitionError,
  type Registry,
  type Run,
  readRunOutput,
} from '../index.ts';
import type { JobStore } from '../ports.ts';

/** A completed run's stored output, read under the current definition. */
export type StoredOutput =
  | { readable: true; output: unknown }
  | { readable: false };

/**
 * The one output read every view projects (dedupe 6): a completed run's output as its job's current definition parses
 * it, or `{ readable: false }` when the job is no longer registered or the stored output no longer parses (schema
 * drift), logged once. A completed run is never turned into an error for that. Any other failure (the store's read)
 * throws, never a completed run with no output.
 */
export async function storedOutput(
  deps: {
    store: JobStore;
    registry: Registry;
    warn: (message: string) => void;
  },
  run: Run,
): Promise<StoredOutput> {
  if (!deps.registry.has(run.jobKey)) return { readable: false };
  try {
    return { readable: true, output: await readRunOutput(deps, run) };
  } catch (err) {
    if (!(err instanceof z.ZodError || err instanceof JobDefinitionError))
      throw err;
    deps.warn(
      `job run ${run.id}: its output no longer reads under the current definition`,
    );
    return { readable: false };
  }
}
