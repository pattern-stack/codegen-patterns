# PW-3c: junctions under `wiring: plain`

**Status:** implemented · **Follows:** PW-3b · **Next:** PW-4 (`project init` for plain)

## Problem

PW-3a refused junctions under plain wiring. Their templates were Nest-decorated end to end. Under Nest, a parent's
service gets its junction's service as an injected property (`@Inject(forwardRef(…))`), and a junction has a Nest
module that imports both parents' modules. `junction new`, and `entity new` in a project with junction YAMLs, were
refused by name.

## Decision

### The junction's own files

- `junction new` reads `target.wiring`. Under plain:
  - the repository and service have no decorators, and `db` is a plain constructor parameter;
  - the service has no `@Optional() @Inject(EVENT_BUS)` property;
  - there is no Nest module, and `index.ts` exports the repository and service instead of a module;
  - a new `<junction>.wiring.ts` (`templates/junction/new/wiring.ejs.t`) exports
    `create<Junction>Repository(db)` and `create<Junction>Service({ repository, left, right })`. Its path is
    `junctionWiringFile` (`src/config/junction-naming.ts`), which the prompt and the emitter both call.
  The Nest text is unchanged byte for byte.

### The parents: the fan-out becomes a constructor argument

- Under plain, a parent's service takes each fanned-out junction's service as a constructor argument, after its
  composed repositories. Nest still injects a property.
- `<entity>.wiring.ts`'s `<Entity>ServiceDeps` lists the junction services after the repositories.
- `entity-locals.js` checks the class graph's `junction_fan_out` edges against the parent's own fan-out. If they ever
  differ, it throws under plain and names both. This is the same check PW-3a added for composed repositories.
- `junctionServicePropertyName` (`src/derived/api/names.ts`) is now the one rule for the property name. Both the
  junction prompts (`junction-fan-out.mjs`) and the emitter call it.

### The composition

- A junction is composed in the module of the parents that fan out to it (`expose_on_parent`). When both or neither
  do, that is its left end's module. In that module:
  - its repository is built with the module's repositories (phase 1);
  - its service is built next, over both ends' repositories;
  - then the parents' services take it (phase 2).
- The module returns it under `junctions: { <junction>: service }`. `junctions` is a reserved key beside
  `repositories`, so an entity that camelCases to either one is refused.
- **A junction that both parents use, across two modules, is refused.** Its service takes both ends' repositories,
  and both ends' services take it, so the two modules would each depend on the other. The refusal names the cycle and
  the junctions on it. A junction only one parent uses can span two modules: it lives in that parent's module, and
  reads the other end's repository from `deps.<module>.repositories`.
- **Module cycles are now checked over the modules themselves.** The check runs over every class edge between
  modules, and replaces PW-3a's `contextCycles` check in the emitter. `contextCycles` passes through owners with no
  context, which are the junctions and the root `entities` module. So it missed a cycle through the root module
  (crm → entities → crm) and one through a junction. The message is the same as before:
  `… modules must depend on each other one way; these depend on each other in a cycle: crm → billing → crm`.
- `wiringFilesBehind` names a junction whose `.wiring.ts` is missing or older than the composition. That happens
  when `entity new` runs before `junction new`. The warning says to run both with `--all`.

### The CLI

- `junction new` is no longer refused under plain.
  - It plans the composition in its pre-flight, before writing anything, so a refusal (a cycle) stops the run there.
    The dry run lists the planned files.
  - It writes the schema barrel with the junction tables and no modules barrel, then the relations manifest, then the
    composition (`writePlainComposition`).
  - If the relations manifest fails, it skips the composition and still prints its summary (JSON included), then
    exits 1, as the Nest path does.
  - The post-step lives in `src/cli/shared/plain-composition.ts`, which `entity new` and `junction new` share.
- Under plain, `entity new` and `junction new` both refuse a project with relationship YAMLs (#679), through one
  helper, `plainRelationshipYamlsRefusal` (`src/cli/shared/storage-only.ts`).
- `regenerateBarrels` takes a separate `junctions` flag. It defaults to `modulesBarrel`, so the Nest and SQLite
  behaviour is unchanged. Before this, the flag that turned off the modules barrel also dropped the junction tables.

## The gate

- `test-smoke-plain` adds:
  - a `tag` entity in crm;
  - a junction `account_tag` (in `test/smoke/fixtures-plain-junctions/`, a sibling folder so the entity loaders never
    read it);
  - a run of `junction new --all` after `entity new --all`.
  The compile half type-checks the junction and its fan-out with no `@nestjs`.
- The usage file attaches a tag from the account side, lists it from the tag side, and reads the link through
  `crm.junctions`. The Postgres half runs this.
- `emit-composition.test.ts` checks:
  - the build order (both ends' repositories, then the junction's repository, then its service, then the parents'
    services);
  - the `junctions` key;
  - the refusal of a junction across modules;
  - a junction only one parent uses, placed in that parent's module across modules.

## Found, not fixed here

The junction service's `detach` deletes by `match.id`, but a junction table has no `id` column (its key is the pair).
It throws `table has no column 'id'`, under Nest as well as plain. Fixing it changes the Nest output, so it's a
separate fix. The usage check removes its link row with Drizzle instead.

## Byte-identity

The Nest output doesn't change: `test-baseline`, the junction snapshots (`test-junction`) and the junction smokes.
