import type { AnyJob } from './define-job.ts';

/**
 * A job FACTORY (codegen JOBS-3): a job whose steps need the host's services. `create` is a plain function from its
 * typed dependencies to a `defineJob(...)`; `deps` names, per dependency, the token the host resolves it by. The
 * factory imports no framework: a Nest host resolves each token from its container (codegen's `JobsEngineModule`),
 * a plain-wiring composition calls `create` with the values it already holds, a
 * test calls it with fakes. A job with no dependencies stays a plain `defineJob` value.
 *
 * ```ts
 * export const reindex = jobFactory({
 *   deps: { search: SearchService, sync: injected<ExecuteIntegrationUseCase<Doc>>('DOC_INTEGRATION_USE_CASE') },
 *   create: ({ search, sync }) => defineJob({ key: 'document.reindex', …, steps: (s) => s.add('run', step({ run: () => sync.execute(…) })) }),
 * });
 * ```
 *
 * A dependency is an object (a service, a use case): a host may hand `create` a stand-in that reaches the instance
 * on first use, so `create` must not read a dependency's fields while it builds the job, only inside a step.
 */
export interface JobFactory<D extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: 'job-factory';
  /** Per dependency, the token the host resolves it by: a class, or a string / symbol token through `injected`. */
  readonly deps: { readonly [K in keyof D]: DepToken<D[K]> };
  /** The job, for these dependencies. Called once per process by the host. */
  create(deps: D): AnyJob;
}

/** A string or symbol token, carrying the type of what it resolves to. */
export interface Injected<T> {
  readonly token: string | symbol;
  /** Type only: never set. */
  readonly __type?: T;
}

/** How a dependency is named: its class (the host's token for it), or `injected<T>(token)`. */
export type DepToken<T = unknown> = (abstract new (...args: never[]) => T) | Injected<T>;

/** The dependencies a `deps` spec resolves to. */
export type DepsOf<S> = {
  [K in keyof S]: S[K] extends abstract new (...args: never[]) => infer I
    ? I
    : S[K] extends Injected<infer T>
      ? T
      : never;
};

/** A string or symbol token for a dependency of type `T`. */
export function injected<T>(token: string | symbol): Injected<T> {
  return { token };
}

/** The token a host resolves a dependency by: the class itself, or the string / symbol. */
export function tokenOf(dep: DepToken): unknown {
  return typeof dep === 'function' ? dep : dep.token;
}

/** Declares a job factory; `deps` types `create`'s argument. */
export function jobFactory<const S extends Record<string, DepToken>>(spec: {
  deps: S;
  create: (deps: DepsOf<S>) => AnyJob;
}): JobFactory<DepsOf<S>> {
  return {
    kind: 'job-factory',
    deps: spec.deps as unknown as JobFactory<DepsOf<S>>['deps'],
    create: spec.create,
  };
}

/** Whether a registry entry is a factory (else a plain `defineJob` value). */
export function isJobFactory(entry: AnyJob | JobFactory): entry is JobFactory {
  return (entry as { kind?: unknown }).kind === 'job-factory';
}

/** One entry of an app's job list: a job, or a factory the host builds it from. */
export type JobEntry = AnyJob | JobFactory;

// ── Building an app's job list (any host) ──────────────────────────────────────────────────────────────────────
//
// Plain jobs as they are; each factory called with its dependencies resolved by `resolve` (a Nest host passes
// `ModuleRef.get(token, { strict: false })`, so a provider of any of its modules resolves). A dependency is handed as
// a stand-in that resolves the instance on first use and forwards to it, so the list can be built while the host is
// still constructing its providers, in any order. `assertResolvable` reaches every dependency once, so a host can stop
// its boot on a missing one rather than the first run. A plain-wiring composition calls `create(deps)` itself.

export type ResolveDep = (token: unknown) => unknown;

/** A stand-in for the dependency `token`: the instance, resolved on first use and cached, every member forwarded. */
function lazyDep(token: unknown, resolve: ResolveDep): object {
  let instance: object | undefined;
  const target = (): object => {
    if (instance === undefined) {
      const resolved = resolve(token);
      if (resolved === null || (typeof resolved !== 'object' && typeof resolved !== 'function')) {
        throw new Error(`job dependency ${String(token)} resolved to ${String(resolved)}, not an object`);
      }
      instance = resolved as object;
    }
    return instance;
  };
  return new Proxy(
    {},
    {
      get: (_, prop) => {
        const self = target();
        const value = Reflect.get(self, prop, self);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(self) : value;
      },
      has: (_, prop) => Reflect.has(target(), prop),
      getPrototypeOf: () => Reflect.getPrototypeOf(target()),
    },
  );
}

/** The jobs, each factory built with lazily resolved dependencies. */
export function buildJobs(entries: readonly JobEntry[], resolve: ResolveDep): AnyJob[] {
  return entries.map((entry) => {
    if (!isJobFactory(entry)) return entry;
    const deps = Object.fromEntries(
      Object.entries(entry.deps).map(([name, dep]) => [name, lazyDep(tokenOf(dep), resolve)]),
    );
    return entry.create(deps);
  });
}

/** Resolves every factory dependency once; throws naming the factory's job and the dependency that fails. */
export function assertResolvable(entries: readonly JobEntry[], jobs: readonly AnyJob[], resolve: ResolveDep): void {
  entries.forEach((entry, i) => {
    if (!isJobFactory(entry)) return;
    for (const [name, dep] of Object.entries((entry as JobFactory).deps)) {
      const token = tokenOf(dep);
      let value: unknown;
      try {
        value = resolve(token);
      } catch (err) {
        throw new Error(
          `job '${jobs[i]?.key}': its dependency '${name}' (${describe(token)}) is not a provider of this app — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (value === undefined || value === null) {
        throw new Error(`job '${jobs[i]?.key}': its dependency '${name}' (${describe(token)}) resolved to nothing`);
      }
    }
  });
}

function describe(token: unknown): string {
  return typeof token === 'function' ? token.name : String(token);
}
