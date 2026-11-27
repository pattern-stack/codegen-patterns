// crew's type assertions (from its wiring.test.ts, split out so `tsc` checks them: each is an expect-error directive,
// so a type that stops refusing fails `just test-wiring` with TS2578).
import { test } from "bun:test";
import { defineModule, defineSystem } from "./fixtures";

test("the types refuse what a manifest didn't declare", () => {
  defineModule({
    name: "vitals",
    kind: "derived",
    dependsOn: ["teams"],
    uses: [],
    // @ts-expect-error mail isn't in dependsOn, so it isn't in deps
    create: ({ mail }) => ({ of: () => mail.send("x") }),
  });
  defineModule({
    name: "vitals",
    kind: "derived",
    // @ts-expect-error there is no module called nope
    dependsOn: ["nope"],
    uses: [],
    create: () => ({ of: () => "" }),
  });
  defineModule({
    name: "mail",
    kind: "stateful",
    // @ts-expect-error a module can't depend on itself
    dependsOn: ["mail"],
    uses: [],
    create: () => ({ send: () => "" }),
  });
  defineModule({
    name: "teams",
    kind: "stateful",
    dependsOn: [],
    uses: [],
    // @ts-expect-error create must return what the registry says teams is
    create: () => ({ agents: () => 3 }),
  });
  defineSystem({
    name: "events",
    uses: [],
    // @ts-expect-error clock isn't in uses
    create: ({ clock }) => ({ append: () => clock.now().length }),
  });
});
