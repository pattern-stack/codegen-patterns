import { describe, expect, test } from "bun:test";
// Ported from crew (`src/core/kernel/__tests__/wiring/wiring.test.ts`), unchanged but for the import.
import { WiringError } from "../index";
import { clock, compose, defineModule, defineSystem, events, mail, teams, vitals } from "./fixtures";

describe("compose", () => {
  test("builds everything in the order it needs, whatever order it was given", () => {
    const wired = compose({ systems: [events, clock], modules: [vitals, mail, teams] });
    expect(wired.order).toEqual(["clock", "events", "teams", "mail", "vitals"]);
    expect(wired.module("mail").send("builder")).toBe("queued 2026-11-22T00:00:00Z");
    expect(wired.module("vitals").of("nobody")).toBe("refused");
  });

  test("each create gets exactly what it declared", () => {
    let seen: string[] = [];
    const nosy = defineModule({
      name: "vitals",
      kind: "derived",
      dependsOn: ["teams"],
      uses: ["clock"],
      create: (deps) => {
        seen = Object.keys(deps).sort();
        return { of: () => "" };
      },
    });
    compose({ systems: [clock, events], modules: [teams, mail, nosy] });
    expect(seen).toEqual(["clock", "teams"]);
  });

  test("a missing module, a missing system and a cycle are refused by name", () => {
    expect(() => compose({ systems: [clock, events], modules: [mail] })).toThrow(
      "module mail needs teams, which isn't composed",
    );
    expect(() => compose({ systems: [clock], modules: [teams, mail] })).toThrow(
      "module mail uses system events, which isn't composed",
    );
    const loopy = defineModule({
      name: "teams",
      kind: "stateful",
      dependsOn: ["vitals"],
      uses: [],
      create: () => ({ agents: () => [] }),
    });
    expect(() => compose({ systems: [clock, events], modules: [loopy, mail, vitals] })).toThrow(
      "modules depend on each other in a cycle: teams → vitals → teams",
    );
    expect(() => compose({ systems: [clock, clock], modules: [] })).toThrow(WiringError);
  });

  test("each system gets its own settings block", () => {
    const seen: unknown[] = [];
    const tuned = defineSystem({
      name: "clock",
      uses: [],
      create: (_deps, settings) => {
        seen.push(settings);
        return { now: () => "" };
      },
    });
    compose({ systems: [tuned], modules: [], settings: { clock: { backend: "fixed" } } });
    compose({ systems: [tuned], modules: [] });
    expect(seen).toEqual([{ backend: "fixed" }, undefined]);
  });

  test("asking for something that wasn't composed throws", () => {
    const wired = compose({ systems: [clock], modules: [teams] });
    expect(() => wired.module("mail")).toThrow("module mail wasn't composed");
    expect(() => wired.system("events")).toThrow("system events wasn't composed");
  });
});
