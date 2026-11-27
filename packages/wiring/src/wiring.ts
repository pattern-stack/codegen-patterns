// Manifests and wiring, with no DI framework. A module or system declares what it is, what it needs and how to make
// it; compose orders them by what they need and calls each `create` with exactly what it declared.
//
// Generic on purpose: nothing here knows an app. `createWiring<Modules, Systems>()` takes two maps, name → what
// `create` returns, and hands back `defineModule`, `defineSystem` and `compose` typed against them. Using something a
// manifest didn't declare is a type error, and so is a `create` that returns the wrong thing.
//
// Lifted from crew (`src/core/kernel/wiring/wiring.ts`), with one addition: a manifest may declare `start` and `stop`.
// `wired.start()` runs every `start` after every `create`, in composition order (systems first, then modules), so a
// hook one part attaches during `create` is in place before any part starts a loop. `wired.stop()` runs the `stop`s
// of the parts that started, in reverse. The app entry owns signals; nothing here listens for one.

export type ModuleKind = "stateful" | "derived";

/**
 * A settings block's checker, as wiring sees it: anything with `parse` (crew uses Zod schemas). Given a block (or
 * nothing), it returns the resolved settings or throws.
 */
export interface SettingsChecker {
  parse(block: unknown): unknown;
}
type Resolved<St> = St extends SettingsChecker ? ReturnType<St["parse"]> : undefined;
export const MODULE_KINDS: readonly ModuleKind[] = ["stateful", "derived"];

/** A module's manifest as compose sees it, with its types erased. */
export interface ModuleManifest {
  readonly name: string;
  readonly kind: ModuleKind;
  /** The modules it uses, through their index.ts. */
  readonly dependsOn: readonly string[];
  /** The systems it uses, through their index.ts. */
  readonly uses: readonly string[];
  /** Its settings: compose resolves its block with this and hands the result to `create`. */
  readonly settings?: SettingsChecker;
  readonly create: (deps: Readonly<Record<string, unknown>>, settings: unknown) => unknown;
  readonly start?: Lifecycle<unknown>;
  readonly stop?: Lifecycle<unknown>;
}

/** A start or stop hook: given what the part's `create` returned. */
export type Lifecycle<Api> = (api: Api) => void | Promise<void>;

/** A system's manifest as compose sees it, with its types erased. */
export interface SystemManifest {
  readonly name: string;
  /** The other systems it uses, through their index.ts. */
  readonly uses: readonly string[];
  /** Its settings (which backend, and the backend's knobs): compose resolves its block with this. */
  readonly settings?: SettingsChecker;
  /**
   * Picks and builds a backend: this is where the system's factory is called. `settings` is the system's own block
   * from compose, resolved by `settings` when the manifest has one (the factory may check it again).
   */
  readonly create: (deps: Readonly<Record<string, unknown>>, settings: unknown) => unknown;
  readonly start?: Lifecycle<unknown>;
  readonly stop?: Lifecycle<unknown>;
}

export class WiringError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WiringError";
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What compose built. Asking for something that wasn't composed throws. */
export interface Wired<M, S> {
  module<N extends keyof M & string>(name: N): M[N];
  system<N extends keyof S & string>(name: N): S[N];
  /** Every name, in the order it was created: systems first, then modules. */
  readonly order: readonly string[];
  /**
   * Runs every part's `start`, in `order`, one after another. If one fails, the parts already started are stopped (in
   * reverse) and the failure is rethrown, naming the part. Starting twice throws.
   */
  start(): Promise<void>;
  /**
   * Runs the `stop` of every part that started, in reverse `order`. Every one runs even if another fails; the failures
   * are thrown together after, naming each part (each original error is the `cause`). Stopping what isn't started (or
   * twice) does nothing. A stop during a start waits for the part starting now, starts no more, then stops them all.
   */
  stop(): Promise<void>;
}

/**
 * Orders items so each comes after everything it needs. Throws on a duplicate name, a need that isn't among the
 * items, or a cycle (naming it: `a → b → a`).
 */
export function orderByNeeds<T extends { readonly name: string }>(
  what: string,
  items: readonly T[],
  needs: (item: T) => readonly string[],
): T[] {
  const byName = new Map<string, T>();
  for (const item of items) {
    if (byName.has(item.name)) throw new WiringError(`two ${what}s are named ${item.name}`);
    byName.set(item.name, item);
  }
  const done = new Set<string>();
  const out: T[] = [];
  const visit = (item: T, path: readonly string[]) => {
    if (done.has(item.name)) return;
    if (path.includes(item.name)) {
      const cycle = [...path.slice(path.indexOf(item.name)), item.name];
      throw new WiringError(`${what}s depend on each other in a cycle: ${cycle.join(" → ")}`);
    }
    for (const need of needs(item)) {
      const next = byName.get(need);
      if (!next) throw new WiringError(`${what} ${item.name} needs ${need}, which isn't composed`);
      visit(next, [...path, item.name]);
    }
    done.add(item.name);
    out.push(item);
  };
  for (const item of items) visit(item, []);
  return out;
}

const pick = (built: ReadonlyMap<string, unknown>, names: readonly string[]) =>
  Object.fromEntries(names.map((n) => [n, built.get(n)]));

/** A manifest's block, resolved by its checker; a bad block names whose it is. */
function resolve(m: { name: string; settings?: SettingsChecker }, block: unknown): unknown {
  try {
    return m.settings?.parse(block);
  } catch (e) {
    throw new WiringError(`settings for ${m.name}: ${(e as Error).message}`);
  }
}

export function createWiring<M extends object, S extends object>() {
  type ModuleName = keyof M & string;
  type SystemName = keyof S & string;

  function defineModule<
    const N extends ModuleName,
    const D extends readonly Exclude<ModuleName, N>[],
    const U extends readonly SystemName[],
    const St extends SettingsChecker | undefined = undefined,
  >(manifest: {
    name: N;
    kind: ModuleKind;
    dependsOn: D;
    uses: U;
    settings?: St;
    create: (deps: Pick<M, D[number]> & Pick<S, U[number]>, settings: Resolved<St>) => M[N];
    start?: Lifecycle<M[N]>;
    stop?: Lifecycle<M[N]>;
  }): ModuleManifest {
    return manifest as unknown as ModuleManifest;
  }

  function defineSystem<
    const N extends SystemName,
    const U extends readonly Exclude<SystemName, N>[],
    const St extends SettingsChecker | undefined = undefined,
  >(manifest: {
    name: N;
    uses: U;
    settings?: St;
    create: (deps: Pick<S, U[number]>, settings: St extends SettingsChecker ? Resolved<St> : unknown) => S[N];
    start?: Lifecycle<S[N]>;
    stop?: Lifecycle<S[N]>;
  }): SystemManifest {
    return manifest as unknown as SystemManifest;
  }

  function compose(parts: {
    systems: readonly SystemManifest[];
    modules: readonly ModuleManifest[];
    /** Each system's and module's settings block, by name. Missing means its defaults. */
    settings?: { readonly [K in SystemName | ModuleName]?: unknown };
  }): Wired<M, S> {
    const systems = new Map<string, unknown>();
    const modules = new Map<string, unknown>();
    const order: string[] = [];
    const built: { kind: "system" | "module"; name: string; manifest: SystemManifest | ModuleManifest; api: unknown }[] =
      [];
    for (const s of orderByNeeds("system", parts.systems, (s) => s.uses)) {
      const block = parts.settings?.[s.name as SystemName];
      const api = s.create(pick(systems, s.uses), s.settings ? resolve(s, block) : block);
      systems.set(s.name, api);
      built.push({ kind: "system", name: s.name, manifest: s, api });
      order.push(s.name);
    }
    for (const m of parts.modules)
      if (systems.has(m.name)) throw new WiringError(`a module and a system are both named ${m.name}`);
    for (const m of parts.modules)
      for (const u of m.uses)
        if (!systems.has(u)) throw new WiringError(`module ${m.name} uses system ${u}, which isn't composed`);
    for (const m of orderByNeeds("module", parts.modules, (m) => m.dependsOn)) {
      const block = parts.settings?.[m.name as ModuleName];
      const api = m.create(
        { ...pick(systems, m.uses), ...pick(modules, m.dependsOn) },
        m.settings ? resolve(m, block) : undefined,
      );
      modules.set(m.name, api);
      built.push({ kind: "module", name: m.name, manifest: m, api });
      order.push(m.name);
    }
    const started: typeof built = [];
    // A start in flight, so a stop that arrives during it (a SIGTERM at boot) can wait for it and stop what it
    // started, instead of leaving it starting loops after stop resolved.
    let starting: Promise<void> | undefined;
    let running = false;
    let cancelled = false;
    const stopStarted = async (): Promise<WiringError[]> => {
      const failures: WiringError[] = [];
      while (started.length > 0) {
        const part = started.pop() as (typeof built)[number];
        try {
          await part.manifest.stop?.(part.api);
        } catch (e) {
          failures.push(new WiringError(`stopping ${part.kind} ${part.name}: ${messageOf(e)}`, { cause: e }));
        }
      }
      return failures;
    };
    const together = (failures: readonly WiringError[]): WiringError =>
      failures.length === 1
        ? (failures[0] as WiringError)
        : new WiringError(failures.map((f) => f.message).join("; "), { cause: failures });
    const run = async (): Promise<void> => {
      for (const part of built) {
        if (cancelled) return;
        try {
          await part.manifest.start?.(part.api);
        } catch (e) {
          const failures = await stopStarted();
          running = false;
          throw together([new WiringError(`starting ${part.kind} ${part.name}: ${messageOf(e)}`, { cause: e }), ...failures]);
        }
        started.push(part);
      }
    };
    return {
      order,
      async start() {
        if (running) throw new WiringError("already started");
        running = true;
        cancelled = false;
        starting = run();
        try {
          await starting;
        } finally {
          starting = undefined;
        }
      },
      async stop() {
        if (starting) {
          cancelled = true;
          await starting.catch(() => undefined);
        }
        const failures = await stopStarted();
        running = false;
        if (failures.length > 0) throw together(failures);
      },
      module(name) {
        if (!modules.has(name)) throw new WiringError(`module ${name} wasn't composed`);
        return modules.get(name) as M[typeof name];
      },
      system(name) {
        if (!systems.has(name)) throw new WiringError(`system ${name} wasn't composed`);
        return systems.get(name) as S[typeof name];
      },
    };
  }

  return { defineModule, defineSystem, compose };
}
