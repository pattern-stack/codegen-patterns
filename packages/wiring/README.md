# @pattern-stack/wiring

Typed manifests and one flat composition, with no DI container. Modules and systems say what they need,
`compose` builds them in dependency order, and `start` and `stop` run in that order and in reverse.

Lifted from crew's `core/kernel/wiring`. Codegen's plain-wiring target (planned: `target: { wiring: plain }`) will
emit its composition against this package.

```ts
import { createWiring } from '@pattern-stack/wiring';

interface Modules { contacts: ContactsApi }
interface Systems { database: Db; events: EventBus }

const { defineModule, defineSystem, compose } = createWiring<Modules, Systems>();

const database = defineSystem({
  name: 'database',
  uses: [],
  create: (_deps, settings) => openPool(settings),
  stop: (db) => db.end(),
});
const events = defineSystem({
  name: 'events',
  uses: ['database'],
  create: ({ database }) => new OutboxBus(database),
  start: (bus) => bus.startDraining(), // runs after every create, so every hook is attached
  stop: (bus) => bus.stopDraining(),
});
const contacts = defineModule({
  name: 'contacts',
  kind: 'stateful',
  dependsOn: [],
  uses: ['database', 'events'],
  create: ({ database, events }) => composeContacts(database, events),
});

const app = compose({ systems: [events, database], modules: [contacts] });
await app.start();
process.on('SIGTERM', () => {
  app.stop().catch((err) => {
    console.error(err); // every stop ran; this names each one that failed (each original error is its `cause`)
    process.exitCode = 1;
  });
});
```

- **Typed.** A `create` gets exactly what its manifest declares in `dependsOn` and `uses`. Reaching anything else
  is a type error, and so is returning the wrong shape.
- **Ordered.** Systems are built before modules, and each part after everything it needs. A duplicate name, a
  missing need, or a cycle (`a → b → a`) throws a `WiringError` that names it.
- **Settings.** Each part can declare a checker (anything with `parse`, such as a Zod schema). `compose` resolves
  that part's settings block through it.
- **Start and stop.** `start()` runs each part's `start` after every `create`, in composition order. If one fails,
  the parts already started are stopped in reverse, and the error names the part that failed. `stop()` runs the
  `stop` of every part that started, in reverse. Every stop runs even when one throws, and the failures are
  reported together, with each original error as the `cause`. A `stop()` that arrives during `start()` waits for
  the part starting now, starts nothing more, and then stops everything that started. The app entry owns signals:
  nothing here calls `process.on`.
- **One namespace.** A module and a system can't share a name, because settings are keyed by name.
- **Settings without a checker.** A system with no checker gets its raw block. A module with no checker gets
  `undefined`, which is crew's behaviour.

There is no per-request scope: everything is built once. Request state belongs in `AsyncLocalStorage`.
