# PW-4: `project init` for `wiring: pattern-stack`

**Status:** implemented · **Follows:** PW-3c

## Problem

`project init` always wrote the Nest scaffold:
- `database.module.ts`, `app.module.ts` and the Nest `main.ts`;
- the modules barrel;
- `nest-logger.ts` and the other vendored files that import `@nestjs/*`;
- decorator flags in `tsconfig.json`.

A pattern-stack project had to delete all that and rewrite `target:` by hand. The smoke did exactly that. Nothing
gave the app what it needs in place of the scaffold: a `database` system, a `compose.ts`, and a `main.ts` that starts
and stops the composition.

## Decision

### Choosing the wiring

- `project init --wiring nest|pattern-stack`. An unknown value is an error that names both.
- A `--wiring` that differs from an existing config's `target.wiring` is refused without `--force`
  (`initWiringRefusal`). Init doesn't rewrite an existing config, so it would write one wiring's app over a config that
  generates the other. With `--force`, the config is rewritten and the two agree. Pattern-stack over a SQLite target
  never reaches init: the config schema refuses it until G7.
- With no flag, init uses the existing config's `target.wiring`, else `nest`. Re-running init on a pattern-stack project
  writes no Nest files.
- A new config gets `target: { database, orm, wiring: pattern-stack, http: none }`.

### What init writes under pattern-stack

| Step | Nest | pattern-stack |
|---|---|---|
| 3 | `shared/database/database.module.ts` | `<backend_src>/database.ts`: `databaseSystem(url)` |
| 4-6 (vendored) | the whole closure | the closure without the 3 files flagged `nest` |
| 7 | `<generated>/modules.ts` | `<generated>/{wiring,composition,openapi}.ts`, over no entity |
| 8 | `app.module.ts` | `<backend_src>/compose.ts`: `composeApp({ databaseUrl? })` |
| 8b | Nest `main.ts` | `<backend_src>/main.ts`: compose, start, `run(app)`, stop |
| tsconfig | decorator flags added | no decorator flags |

The other steps are the same under both wirings:
- `codegen.config.yaml` and `drizzle.config.ts`;
- the schema barrel, `relations.ts`, `api-includes.ts` and `app-config.ts`;
- the schema root, `entities/README.md` and the frontend deps.

### The files

- **`database.ts`** builds a `pg` pool from `url ?? DATABASE_URL`. Its `defineSystem` returns `{ db: drizzle({ client:
  pool, relations }) }` and ends the pool on stop. The pool connects on first use, so composing and stopping needs no
  database.
- **`compose.ts`** returns `compose({ systems: [databaseSystem(url)], modules: [...MODULES] })`. The type `App` is its
  return.
- **`main.ts`** composes, starts, runs `run(app)` and then stops. A SIGINT or SIGTERM stops the app, then exits.
  `run` is the app's work and is a placeholder: there is no HTTP layer (`http: none`), and an app here is a CLI,
  hook, worker or MCP server. It runs to completion, so `stop` always runs, and an app that serves calls its own loop
  from `run`.
- **The empty composition** comes from the same emitter (`emptyPatternStackComposition`, over an empty set). That
  way `compose.ts` and `main.ts` compile before the first `entity new`, which rewrites it.
- **Ownership.** The project owns `database.ts`, `compose.ts` and `main.ts`. They are never overwritten, not even
  with `--force`, like `app.module.ts` and the Nest `main.ts`. The composition files are codegen's. Init writes them
  only when they're absent, even with `--force`: forcing the empty set would empty `MODULES` until the next `entity new`.
- **A signal during start.** `stop()` waits for the start in flight and stops what started; `start()` then
  resolves. `main.ts` keeps a `stopping` flag so it doesn't call `run` on a stopped app.

### The vendored closure

- `VendoredRuntimeFile.nest` flags the files that import `@nestjs/*`: `nest-logger.ts`,
  `nest-db-constraint-filter.ts` and `pipes/zod-validation.pipe.ts`.
- `vendoredRuntimeFiles(wiring)` is the one filter. `project init` and `project update` both call it.
- Under pattern-stack, `project update` also removes any Nest-flagged file still on disk, for example from a project
  that started on nest. Those files import packages the project no longer has. They are reported as `removed` and
  count toward the uncommitted-changes check.
- A unit test holds the flag to the content: a file is flagged exactly when it imports `@nestjs` or
  `reflect-metadata`.

### Layout and install lines

- `ProjectLayout` gains `databaseSystem` (`<backend_src>/database.ts`) and `composeTs` (`<backend_src>/compose.ts`).
- `PATTERN_STACK_INSTALL_LINES`: `@pattern-stack/wiring`, the same drizzle pins, `pg` and `zod`, with no Nest.
- Init prints them under pattern-stack. docs/CONSUMER-SETUP.md › A project without NestJS carries them, and the
  install-lines test holds the doc to them.

## The gate

`test-smoke-pattern-stack`:
- inits with `--wiring pattern-stack`. It no longer rewrites the config or deletes Nest files; it asserts init
  wrote none.
- asserts init turned on no decorator flags.
- runs `tsc` on the freshly initialized project, before any entity.
- after generation, runs `bun src/main.ts` and checks it prints the composed order (`database, crm, billing,
  entities`) and exits 0.
- runs its usage file (`crud-check.ts`) through the generated `composeApp`, instead of building its own `database`
  system.

Unit tests (`project.test.ts`) cover:
- the plan under pattern-stack;
- the wiring read from an existing config;
- tsconfig without decorators;
- a second run that keeps a user-edited `main.ts`, even with `--force`;
- the refusal of a `--wiring` the config disagrees with;
- a composition `--force` doesn't empty;
- `project update` removing a Nest file under pattern-stack;
- the `nest` flag held to the file content.

## Open

- `@pattern-stack/wiring` is not on npm yet. The install line names it, but publishing it is a release decision.
- The junction `detach` workaround in `crud-check.ts` stays until the detach fix (its own PR, off main) is in this
  stack's base.
