// Start and stop (PW-2, the platform plan §5): every `start` runs after every `create`, in composition order (systems,
// then modules); `stop` runs in reverse, for the parts that started.
import { describe, expect, test } from "bun:test";
import { createWiring, WiringError } from "../index";

interface Modules {
  scheduler: { ticks: () => number };
  bridge: { attached: () => boolean };
}
interface Systems {
  db: { open: () => boolean };
  events: { hooks: string[] };
}

const { defineModule, defineSystem, compose } = createWiring<Modules, Systems>();

function parts(log: string[], fail: { start?: string; stop?: string } = {}) {
  const hook = (name: string, phase: "start" | "stop") => () => {
    log.push(`${phase} ${name}`);
    if (fail[phase] === name) throw new Error(`${name} broke`);
  };
  let open = false;
  const db = defineSystem({
    name: "db",
    uses: [],
    create: () => {
      log.push("create db");
      return { open: () => open };
    },
    start: () => {
      open = true;
      hook("db", "start")();
    },
    stop: hook("db", "stop"),
  });
  const events = defineSystem({
    name: "events",
    uses: ["db"],
    create: () => {
      log.push("create events");
      return { hooks: [] };
    },
    start: async (api) => {
      // The scheduler bug (swe-brain 0.20.1): a boot tick that drains before every hook is attached loses
      // deliveries. Every hook attaches in `create`, so by the first `start` they're all there.
      log.push(`events sees ${api.hooks.length} hook(s)`);
      hook("events", "start")();
    },
    stop: hook("events", "stop"),
  });
  const bridge = defineModule({
    name: "bridge",
    kind: "stateful",
    dependsOn: [],
    uses: ["events"],
    create: ({ events }) => {
      log.push("create bridge");
      events.hooks.push("bridge");
      return { attached: () => events.hooks.includes("bridge") };
    },
    // No start: it only attaches. Its stop still runs.
    stop: hook("bridge", "stop"),
  });
  const scheduler = defineModule({
    name: "scheduler",
    kind: "stateful",
    dependsOn: ["bridge"],
    uses: ["db"],
    create: ({ db }) => {
      log.push("create scheduler");
      return { ticks: () => (db.open() ? 1 : 0) };
    },
    start: hook("scheduler", "start"),
    stop: hook("scheduler", "stop"),
  });
  return { systems: [events, db], modules: [scheduler, bridge] };
}

describe("start and stop", () => {
  test("start runs after every create, in order; stop runs in reverse", async () => {
    const log: string[] = [];
    const wired = compose(parts(log));
    expect(log).toEqual(["create db", "create events", "create bridge", "create scheduler"]);
    log.length = 0;
    await wired.start();
    expect(log).toEqual(["start db", "events sees 1 hook(s)", "start events", "start scheduler"]);
    expect(wired.module("scheduler").ticks()).toBe(1);
    log.length = 0;
    await wired.stop();
    expect(log).toEqual(["stop scheduler", "stop bridge", "stop events", "stop db"]);
  });

  test("a failed start stops what already started, in reverse, and names the part", async () => {
    const log: string[] = [];
    const wired = compose(parts(log, { start: "scheduler" }));
    log.length = 0;
    await expect(wired.start()).rejects.toThrow("starting module scheduler: scheduler broke");
    expect(log).toEqual([
      "start db",
      "events sees 1 hook(s)",
      "start events",
      "start scheduler",
      "stop bridge",
      "stop events",
      "stop db",
    ]);
  });

  test("every stop runs even when one fails; the failures are thrown together", async () => {
    const log: string[] = [];
    const wired = compose(parts(log, { stop: "events" }));
    await wired.start();
    log.length = 0;
    const err = await wired.stop().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WiringError);
    expect((err as Error).message).toBe("stopping system events: events broke");
    expect(log).toEqual(["stop scheduler", "stop bridge", "stop events", "stop db"]);
  });

  test("starting twice throws; stopping what isn't started does nothing; a stopped app starts again", async () => {
    const log: string[] = [];
    const wired = compose(parts(log));
    await wired.stop();
    log.length = 0;
    await wired.start();
    await expect(wired.start()).rejects.toThrow("already started");
    await wired.stop();
    await wired.stop();
    expect(log.filter((l) => l.startsWith("stop"))).toHaveLength(4);
    await wired.start();
    await wired.stop();
  });

  test("two overlapping stops stop each part once, in reverse, and neither resolves before the last hook", async () => {
    const log: string[] = [];
    const slow = (name: string) => async () => {
      log.push(`stop ${name} begins`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`stop ${name} ends`);
    };
    const db = defineSystem({ name: "db", uses: [], create: () => ({ open: () => true }), stop: slow("db") });
    const events = defineSystem({ name: "events", uses: ["db"], create: () => ({ hooks: [] }), stop: slow("events") });
    const wired = compose({ systems: [db, events], modules: [] });
    await wired.start();
    const resolved: string[] = [];
    const first = wired.stop().then(() => resolved.push(`first after ${log.length} lines`));
    const second = wired.stop().then(() => resolved.push(`second after ${log.length} lines`));
    await Promise.all([first, second]);
    expect(log).toEqual(["stop events begins", "stop events ends", "stop db begins", "stop db ends"]);
    expect(resolved).toEqual(["first after 4 lines", "second after 4 lines"]);
  });

  test("a settings checker's failure keeps its cause and its message", () => {
    const issue = new Error("port: expected a number");
    const bad = defineSystem({
      name: "db",
      uses: [],
      settings: {
        parse: () => {
          throw issue;
        },
      },
      create: () => ({ open: () => true }),
    });
    const err = (() => {
      try {
        compose({ systems: [bad], modules: [] });
      } catch (e) {
        return e as WiringError;
      }
    })();
    expect(err).toBeInstanceOf(WiringError);
    expect(err?.message).toBe("settings for db: port: expected a number");
    expect(err?.cause).toBe(issue);
  });

  test("a part with no hooks composes, starts and stops as before", async () => {
    const plain = defineSystem({ name: "db", uses: [], create: () => ({ open: () => true }) });
    const wired = compose({ systems: [plain], modules: [] });
    await wired.start();
    await wired.stop();
    expect(wired.order).toEqual(["db"]);
  });
});

test("the types give a hook what its part's create returns", () => {
  defineSystem({
    name: "db",
    uses: [],
    create: () => ({ open: () => true }),
    start: (api) => void api.open(),
    // @ts-expect-error db's api has no `close`
    stop: (api) => api.close(),
  });
});

describe("stop during start, names, causes", () => {
  test("a stop that arrives while a start is in flight waits for it, starts nothing more, and stops what started", async () => {
    const log: string[] = [];
    let release: () => void = () => undefined;
    let released = false;
    const slow = defineSystem({
      name: "db",
      uses: [],
      create: () => ({ open: () => true }),
      start: () =>
        released
          ? undefined
          : new Promise<void>((resolve) => {
              log.push("start db (pending)");
              release = () => {
                released = true;
                resolve();
              };
            }),
      stop: () => void log.push("stop db"),
    });
    const later = defineSystem({
      name: "events",
      uses: ["db"],
      create: () => ({ hooks: [] }),
      start: () => void log.push("start events"),
      stop: () => void log.push("stop events"),
    });
    const wired = compose({ systems: [slow, later], modules: [] });
    const starting = wired.start();
    const stopping = wired.stop();
    release();
    await starting;
    await stopping;
    expect(log).toEqual(["start db (pending)", "stop db"]);
    await wired.start();
    expect(log.at(-1)).toBe("start events");
    await wired.stop();
  });

  test("a module and a system can't share a name", () => {
    const db = defineSystem({ name: "db", uses: [], create: () => ({ open: () => true }) });
    const clash = { ...defineModule({ name: "bridge", kind: "stateful", dependsOn: [], uses: [], create: () => ({ attached: () => true }) }), name: "db" };
    expect(() => compose({ systems: [db], modules: [clash] })).toThrow("a module and a system are both named db");
  });

  test("a failure keeps the original error as its cause, and a thrown non-Error reads as itself", async () => {
    const boom = new Error("connect ECONNREFUSED");
    const db = defineSystem({ name: "db", uses: [], create: () => ({ open: () => true }), start: () => { throw boom; } });
    const err = await compose({ systems: [db], modules: [] }).start().catch((e: unknown) => e);
    expect((err as Error).cause).toBe(boom);
    const str = defineSystem({ name: "db", uses: [], create: () => ({ open: () => true }), start: () => { throw "boom"; } });
    await expect(compose({ systems: [str], modules: [] }).start()).rejects.toThrow("starting system db: boom");
  });
});
