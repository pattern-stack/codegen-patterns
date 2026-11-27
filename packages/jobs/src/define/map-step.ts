import type { z } from 'zod';
import { JobDefinitionError } from '../model/errors.ts';
import type { ItemRef, Keyed } from '../model/item.ts';
import type { RetryPolicy } from '../policy/retry.ts';
import type { ItemOutcome, StopPredicate } from '../policy/stop.ts';
import type { ResultRecorder } from '../ports/result-recorder.ts';
import { erasedGates, type Gate } from './gate.ts';
import type { ItemPresenter } from './item-view.ts';
import { type LimiterRefs, stepLimitersOf } from './limits.ts';
import type {
  BatchResult,
  Effect,
  ErasedMapStep,
  ErasedStep,
  ItemSource,
  MapStepOutput,
  StepDef,
} from './step.ts';

export interface MapStepOptions<C, Item, R> {
  /** The step's item refs (entity ids, never content): usually from an earlier step's output, or a paged source. */
  items: (
    ctx: C,
  ) => readonly ItemRef[] | ItemSource | Promise<readonly ItemRef[]>;
  /**
   * Each item's idempotency key: what the work means plus which thing it is about, never the run, the time or the
   * attempt. The same key gets the same result, in any run of the same job and step within a tenant. Keys
   * reach events and logs: never put content in one (name the meaning by a version or a hash, the item by its id).
   */
  key: (ref: ItemRef, ctx: C) => string;
  /** Loads what `run` needs for one chunk's refs, in their order. Held in memory, never stored. Default: the refs. */
  hydrate?: (refs: readonly ItemRef[], ctx: C) => Promise<readonly Item[]>;
  /** One call over a batch of items: one result per item, in order. Throw `NonRetryableError` for a bad item. */
  run: (
    batch: readonly Keyed<Item>[],
    ctx: C,
  ) => Promise<readonly R[] | BatchResult<R>>;
  /** Validates each result before it is stored. */
  result?: z.ZodType<R>;
  /**
   * Where the results live (the job kind's own tables). Without one, the store keeps them, which only a store that
   * keeps values does; `'none'` for void results (nothing is cached across runs then). A `'none'` step whose batch
   * returns a value fails its chunk at run time: the types can't check it here, because `R` is inferred from `run`
   * after this field is read.
   */
  results?: ResultRecorder<NoInfer<R>> | 'none';
  /**
   * The cache the step reads and writes, shared by every step (of this job or another) that names it. Default: the
   * step's own, `<jobKey>/<step>`. The key names the meaning: two steps that share a scope give the same answer for the
   * same key, so a key that stays the same through a semantic change (a new standard, prompt or model under one hash)
   * serves the old answer from every step that shares it. Steps sharing a scope declare the same `result` schema
   * object (checked by `defineJob` within a job and by `createRegistry` across jobs). Only the store's cache is
   * shared: a step with a recorder or `'none'` results takes none. No `/` in it, so it never names a step's own
   * scope. Tenant-scoped like every cache.
   */
  cacheScope?: string;
  /** Items per call: a fact about the provider. */
  batch: { max: number };
  /**
   * The quotas each call draws on: `'llm-calls'` (one bucket), `{ name: 'decisions', per: 'tenant' }`
   * (one per tenant), or a list, every one taken per call.
   */
  limiter: LimiterRefs;
  /** An ordered early stop. Items past it are discarded, so the result never depends on how far ahead the engine worked. */
  stopWhen?: StopPredicate<R>;
  /** Per chunk. Default `DEFAULT_RETRY`. */
  retry?: RetryPolicy;
  /** A call's estimated cost, reserved against the run's budget before the call and drawn on its limiter. */
  cost?: (batch: readonly Keyed<Item>[]) => { tokens?: number; usd?: number };
  effect?: Effect;
  /**
   * Conditions outside the run the step needs: read before it starts and at the start of each chunk. A closed one
   * parks the step until it opens; a batch that finds one closed partway throws `GateClosedError(name)`.
   */
  gates?: readonly Gate<C>[];
  /**
   * How each item reads on a run page (`ItemView`): pure and synchronous, run when the page reads the items, never
   * stored and never in the definition version. Without one, an item reads as its key.
   */
  present?: ItemPresenter<NoInfer<R>>;
}

export interface MapStepDefinition<C, Item, R>
  extends StepDef<C, MapStepOutput<R>> {
  readonly kind: 'map';
  readonly options: MapStepOptions<C, Item, R>;
}

const pagesOf = (refs: readonly ItemRef[]): ItemSource => ({
  async page(cursor, limit) {
    const from = cursor ? Number(cursor) : 0;
    const to = Math.min(refs.length, from + limit);
    return {
      refs: refs.slice(from, to),
      next: to < refs.length ? String(to) : null,
    };
  },
});

const isSource = (x: unknown): x is ItemSource =>
  typeof x === 'object' &&
  x !== null &&
  typeof (x as { page?: unknown }).page === 'function';

/**
 * A step that applies one function to many independent items. Declaring them independent is what lets the engine
 * split, batch, parallelize and retry them one by one. A job states facts here (batch size, limiter, stop, retry),
 * never chunk sizes or parallelism.
 */
export function mapStep<C, Item = ItemRef, R = unknown>(
  options: MapStepOptions<C, Item, R>,
): MapStepDefinition<C, Item, R> {
  const max = options.batch.max;
  if (!(Number.isInteger(max) && max >= 1))
    throw new JobDefinitionError('a map step needs batch.max ≥ 1, an integer');
  const limiters = stepLimitersOf(options.limiter);
  if (!limiters.length)
    throw new JobDefinitionError('a map step names its limiter');
  const { stopWhen, hydrate, cost, result, results, cacheScope, present } =
    options;
  if (cacheScope !== undefined) {
    if (!cacheScope || cacheScope.includes('/'))
      throw new JobDefinitionError(
        `a map step's cacheScope is a non-empty name without '/': ${JSON.stringify(cacheScope)}`,
      );
    if (results !== undefined)
      throw new JobDefinitionError(
        `cacheScope ${cacheScope}: only the store's cache is shared, so a step with a recorder or 'none' results takes none`,
      );
    if (!result)
      throw new JobDefinitionError(
        `cacheScope ${cacheScope}: a step sharing a cache declares its result schema`,
      );
  }
  const erased: ErasedMapStep = {
    kind: 'map',
    async source(ctx) {
      const items = await options.items(ctx as C);
      return isSource(items) ? items : pagesOf(items);
    },
    key: (ref, ctx) => options.key(ref, ctx as C),
    async hydrate(refs, ctx) {
      if (!hydrate) return [...refs];
      return [...(await hydrate(refs, ctx as C))];
    },
    async run(batch, ctx) {
      const out = await options.run(batch as readonly Keyed<Item>[], ctx as C);
      return Array.isArray(out) ? { results: out } : (out as BatchResult<R>);
    },
    parse: (r) => (result ? result.parse(r) : r),
    resultSchema: result,
    results:
      results === undefined || results === 'none'
        ? results
        : {
            save: (tenantId, runId, rows) =>
              results.save(
                tenantId,
                runId,
                rows.map((x) => ({ ...x, result: x.result as R })),
              ),
            load: (tenantId, keys) => results.load(tenantId, keys),
          },
    cacheScope,
    stopWhen:
      stopWhen &&
      ((o, i, before) =>
        stopWhen(o as ItemOutcome<R>, i, before as readonly ItemOutcome<R>[])),
    cost(batch) {
      const c = cost?.(batch as readonly Keyed<Item>[]);
      return { tokens: c?.tokens ?? 0, usd: c?.usd ?? 0 };
    },
    batchMax: max,
    limiters,
    retry: options.retry,
    effect: options.effect ?? 'idempotent',
    gates: erasedGates(options.gates),
    present:
      present &&
      ((item) => present({ ...item, result: item.result as R | null })),
  };
  return { kind: 'map', options, erased };
}

/**
 * Steps that share a `cacheScope` declare the same `result` schema object, so one cache never holds two shapes. A
 * schema's identity, not its JSON Schema: a part JSON Schema can't express reads as `{}`, so two shapes could look
 * equal. Share a scope by sharing one schema constant. `seen` carries the scopes across jobs (the registry).
 */
export function checkCacheScopes(
  owner: string,
  steps: readonly { name: string; erased: ErasedStep }[],
  seen: Map<string, { at: string; schema: unknown }> = new Map(),
): void {
  for (const { name, erased } of steps) {
    if (erased.kind !== 'map' || erased.cacheScope === undefined) continue;
    const at = `${owner}/${name}`;
    const first = seen.get(erased.cacheScope);
    if (!first) {
      seen.set(erased.cacheScope, { at, schema: erased.resultSchema });
      continue;
    }
    if (first.schema !== erased.resultSchema)
      throw new JobDefinitionError(
        `cacheScope ${erased.cacheScope}: ${at} and ${first.at} share it with different result schemas (share one schema object)`,
      );
  }
}
