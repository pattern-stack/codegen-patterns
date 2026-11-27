// The registry and manifests crew's tests use, shared by compose.test.ts and types.test.ts.
import { createWiring } from "../index";

// A registry of its own.
export interface Modules {
  teams: { agents: () => string[] };
  mail: { send: (to: string) => string };
  vitals: { of: (agent: string) => string };
}
export interface Systems {
  clock: { now: () => string };
  events: { append: (e: string) => number };
}

export const { defineModule, defineSystem, compose } = createWiring<Modules, Systems>();

export const clock = defineSystem({
  name: "clock",
  uses: [],
  create: () => ({ now: () => "2026-11-22T00:00:00Z" }),
});
export const events = defineSystem({
  name: "events",
  uses: ["clock"],
  create: ({ clock }) => {
    const log: string[] = [];
    return { append: (e) => log.push(`${clock.now()} ${e}`) };
  },
});
export const teams = defineModule({
  name: "teams",
  kind: "stateful",
  dependsOn: [],
  uses: [],
  create: () => ({ agents: () => ["lead", "builder"] }),
});
export const mail = defineModule({
  name: "mail",
  kind: "stateful",
  dependsOn: ["teams"],
  uses: ["clock", "events"],
  create: ({ teams, clock, events }) => ({
    send: (to) => {
      events.append(`mail to ${to}`);
      return teams.agents().includes(to) ? `queued ${clock.now()}` : "refused";
    },
  }),
});
export const vitals = defineModule({
  name: "vitals",
  kind: "derived",
  dependsOn: ["teams", "mail"],
  uses: [],
  create: ({ mail }) => ({ of: (agent) => mail.send(agent) }),
});
