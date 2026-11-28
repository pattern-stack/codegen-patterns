import { z } from 'zod';
import type { ErasedStep } from './step.ts';

/** cyrb53: a small, pure 53-bit string hash. Portable (no node:crypto), so a workflow sandbox can run it too. */
function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A schema as JSON Schema, for `describe` and the version. A part JSON Schema can't express (a date, a custom check)
 * reads as `{}` in place, so the rest of the shape still counts: two shapes that differ outside such a part get
 * different versions. A change inside one changes nothing, so its job bumps `version`. Only a schema the converter
 * refuses outright reads as opaque.
 */
export function schemaOf(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { opaque: true };
  }
}

/** A wait step's timeout as plain facts: after how long, and whether it fails or settles with its fallback value. */
export function waitTimeoutOf(
  erased: Extract<ErasedStep, { kind: 'wait' }>,
): { afterMs: number; fallback: 'fail' | 'value' } | null {
  if (!erased.timeout) return null;
  return {
    afterMs: erased.timeout.afterMs,
    fallback: erased.timeout.fallback === 'fail' ? 'fail' : 'value',
  };
}

/** Where a value lives, as its recorder option names it: the store by default, nowhere ('none'), or a recorder. */
export function whereRecorded(r: unknown): 'store' | 'recorder' | 'none' {
  if (r === undefined) return 'store';
  return r === 'none' ? 'none' : 'recorder';
}

/** What a step contributes to the version. The keys' order is part of the hash: never reorder them. */
function stepShape(name: string, erased: ErasedStep): Record<string, unknown> {
  switch (erased.kind) {
    // A child's own version is never hashed: a change to its code doesn't strand open parents; a change to its shapes does.
    case 'children':
      return {
        name,
        kind: erased.kind,
        child: erased.job.key,
        input: schemaOf(erased.job.input),
        output: schemaOf(erased.job.output),
        onFailure: erased.onFailure,
        single: erased.single,
      };
    case 'wait':
      return {
        name,
        kind: erased.kind,
        signal: erased.signal,
        value: schemaOf(erased.value),
        timeout: waitTimeoutOf(erased),
      };
    case 'map':
      return {
        name,
        kind: erased.kind,
        batchMax: erased.batchMax,
        retry: erased.retry ?? null,
        effect: erased.effect,
        results: whereRecorded(erased.results),
        result: erased.resultSchema ? schemaOf(erased.resultSchema) : null,
        // Where the results live, as `results` is: a run resumed under another scope would read its done items'
        // results from a cache that never held them. Only when set, so a step without one keeps its hash.
        ...(erased.cacheScope === undefined
          ? {}
          : { cacheScope: erased.cacheScope }),
        // Present only when declared, so a step without a stop keeps the version it had.
        ...(erased.stopWhen ? { stopWhen: true } : {}),
      };
    case 'step':
      return {
        name,
        kind: erased.kind,
        retry: erased.retry ?? null,
        effect: erased.effect,
        recorded: whereRecorded(erased.recorder),
      };
  }
}

export interface VersionedParts {
  key: string;
  input: z.ZodType;
  output: z.ZodType;
  steps: readonly { name: string; erased: ErasedStep }[];
  inputRecorded: 'store' | 'recorder' | 'none';
  /** The author's behaviour version (`defineJob({ version })`). */
  behaviour: number;
}

/**
 * A stable hash of a definition's structure and declared facts: its key, its behaviour version, where its input lives,
 * its input and output shapes, and each step's name, kind, retry, effect and where its value lives (for a map step
 * also its batch size, its result schema, its shared cache scope and whether it declares a `stopWhen`; for a signal wait its signal, value
 * schema and timeout). A map step's `key` and its stop's rule are code, so only the stop's presence counts: a key's
 * meaning is versioned by the key strings it makes. Stored on each run, so a run is resumed only under the definition
 * it was made by. It never reads code text: the same step compiles to different text in the TypeScript a script runs
 * and the dist a worker runs, and a hash of it would strand every run started by another build. A change to a step's
 * code that an open run must not resume under is declared by bumping `version`. Limiters and gates are left out: they
 * change when work runs, never what it computes.
 */
export function definitionVersion(job: VersionedParts): string {
  const steps = job.steps.map(({ name, erased }) => stepShape(name, erased));
  const text = JSON.stringify({
    key: job.key,
    version: job.behaviour,
    inputRecorded: job.inputRecorded,
    input: schemaOf(job.input),
    output: schemaOf(job.output),
    steps,
  });
  const hex = (n: number) => n.toString(16).padStart(14, '0');
  return `${hex(cyrb53(text, 1))}${hex(cyrb53(text, 2))}`.slice(0, 16);
}
