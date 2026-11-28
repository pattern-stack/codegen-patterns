# PW-3a: `target: { wiring: pattern-stack, http: none }` — decorator-free classes, one composition per context

**Status:** implemented · **Follows:** PW-0, PW-1, PW-2 · **Next:**
PW-3b (`<Context>Repositories` bundles, `openapi.ts`), PW-3c (junctions), PW-4 (`project init` for pattern-stack)

## Problem

Codegen emits a NestJS app. Pattern-stack wiring is the same repositories, services and use cases with no decorators,
composed by a typed composition with no DI container (`@pattern-stack/wiring`, PW-2), and no HTTP layer at all for
CLI, hook and MCP apps.

## Decision

### The keys: `target.wiring` and `target.http`, one table

- `TARGET_APPS` (`src/targets/apps.ts`) lists the supported combinations: `{ wiring: nest, http: nest }` (the
  default, the first row) and `{ wiring: pattern-stack, http: none }`. H-1 adds `pattern-stack/hono`.
- The config schema derives from that table, the way `TARGET_PAIRS` drives the pair.
  - Both keys are optional, and an absent `http` follows the wiring's own row.
  - An unsupported combination is refused, naming the supported ones (`{ wiring: pattern-stack, http: nest } is not a
    supported app`).
  - A wrong value names the key and its values (`http: hono is not one of nest, none`).
  - `wiring: pattern-stack` on a storage-only pair (SQLite) is refused until G7.
- A config without the keys parses as before, so the Nest output is byte-identical. `codegen-config.schema.json`
  is regenerated.

### What pattern-stack emits, per entity

- The table, DTOs, repository, service and use cases, from the **same templates**. Each Nest line is wrapped in a
  `patternStackWiring` conditional, so the Nest text is unchanged byte for byte:
  - no `@Injectable()`;
  - `db` is a plain constructor parameter, not `@Inject(DRIZZLE)`;
  - the service has no `@Optional() @Inject(EVENT_BUS)` property (lifecycle events come with S-1);
  - use cases throw PW-0's `NotFoundError` / `BadRequestError` (`errorsImport`, `runtime/errors.ts`, vendored as
    `<shared>/errors.ts`) instead of Nest's exceptions. A child's `sort_not_combinable` refusal keeps its code.
- **`<entity>.wiring.ts`** (`wiring.ejs.t`), the entity's factories, printed by the template that knows the
  constructors:
  - `create<Entity>Repository(db[, baseRepository])`;
  - `create<Entity>Services({ repository, <entity>Repo… })`, which returns `{ service, useCases: { findById, list,
    create, update, delete, <query method>…, search } }`. A search takes the list use case.
  - The service-deps keys are `repositoryPropertyName(entity)` (`src/derived/api/names.ts`), the one rule the
    service's constructor parameters also use. The two factory names are `repositoryFactoryName` /
    `servicesFactoryName` there too, which the template and the composition both print, and the file's path is
    `entityModuleNaming(...).wiringFile`.
- **Skipped by name** (printed: `wiring pattern-stack — skipped N Nest-only files (…)`): the controller, the search
  controller, the Nest module, the integration-source module, and the `<generated>/modules.ts` Nest barrel. The
  barrel exports the repository and service instead of the module and controller.
- **Refused by name, each with the step that lifts it:**
  - `emits:` (the typed bus is decorated; S-1);
  - EAV;
  - an integration `surface:` (S-3);
  - an entity a junction fans out to (PW-3c);
  - `junction new` and `relationship new` (`patternStackWiringRefusal`, `src/cli/shared/storage-only.ts`: junctions PW-3c,
    relationships #679);
  - `entity new` in a project that has junction or relationship YAMLs, rather than generating with their tables
    silently missing from the schema barrel.

### The composition: one module per context (d27, d29)

`emitComposition` (`src/emitters/composition/emit-composition.ts`) is a whole-set emitter. It runs as the
`entity new` post-step under pattern-stack, after the schema barrel and the relations manifest, and the Nest post-steps
after it are skipped by name.
- **`<modules_dir>/<context>/module.ts`** per `context:`, and `<modules_dir>/module.ts` (module `entities`) for the
  entities with none. Each one:
  - exports `compose<Module>(deps)`, which builds **every repository of the module first**, in the class graph's
    order (a base before its child), **then every service** and its use cases;
  - returns `{ repositories: { <entity>… }, <entity>: { service, useCases }… }`;
  - exports a `defineModule` manifest with `uses: ['database']` and `dependsOn` set to the modules whose
    repositories it takes. Another module's repository is read from `deps.<module>.repositories.<entity>`.
  - Building in two phases is what makes mutual composition work: a `belongs_to` one way and a `has_many` back is
    an entity-level cycle but not a class-level one (PW-1).
- **A cycle between modules is refused**, naming it (`contextCycles`, PW-1, over the modules the composition builds:
  an entity with no `context:` is in the root module `entities`, not a pass-through). Modules depend on each other
  one way: a context entity and a root entity that compose each other's repositories are a `crm → entities → crm`
  refusal at generation, not a circular type at `tsc` or a cycle at `compose()`.
- **Module names are a context's own.** A context whose camelCased name is `entities` (the root module) or
  `database` (the system) is refused, and so are two contexts that camelCase to one name.
- **One set of composed repositories.** The composition passes each service its repositories from the class
  graph's service edges (`composedRepositoryOwners`, `src/derived/wiring/classes.ts`), and `<entity>.wiring.ts`
  declares them from `repositoryDeps`, which the Nest service's constructor also reads. Under pattern-stack,
  `entity-locals.js` throws, naming both, if they ever differ; both sides pick a composed repository with
  `composedRepositoryOwners`' one test.
- **The dry run predicts a pattern-stack run:** the schema barrel without the modules barrel, and the composition's files
  (or its refusal: a module cycle, a reserved name).
- **Switching `target.wiring` removes the other wiring's generated files** (`stale-files.ts`). It removes only files
  whose first line is codegen's banner, and names each one.
  - Going pattern-stack removes the Nest controllers, `*.module.ts` and `<generated>/modules.ts`, plus any context
    `module.ts` no longer composed.
  - Going nest removes every context `module.ts`, every `*.wiring.ts`, `<generated>/wiring.ts` and
    `<generated>/composition.ts`.
- The skip line names every post-step pattern-stack doesn't run: subsystems, the ScopeEntityType union, events, bridge,
  jobs, orchestration, the semantic model, frontend and integrations.
- **`<generated>/wiring.ts`**: `ModuleApis` (each module's `ReturnType`), `SystemApis` (`database: { db }`), and
  `createWiring`'s `defineModule` / `defineSystem` / `compose` typed against them.
- **`<generated>/composition.ts`**: `MODULES`, every manifest, for the app's `compose.ts` (PW-4).

PW-1's class graph changed in one place. A service's edges onto other owners are now exactly its constructor
arguments: relation methods (a composed repository) and junction fan-out (a junction service). A child's flat reads
onto its base go through its own repository, which holds the base's, so they are no longer service edges. The Nest
module imports are unchanged (byte-identical).

## The gate: `test-smoke-pattern-stack` (in `test-all`)

`test/smoke/run-smoke-pattern-stack.ts` with `test/smoke/fixtures-pattern-stack/`. The fixtures are:
- crm: `account` with a has_many `contacts`, a query and a search; `contact`, which belongs_to `account`; and a
  joined-table family, `party` (base, discriminator `kind`) with its child `person`;
- billing: `invoice`, which belongs_to `account`;
- a root `note`. The steps:
1. Install `drizzle-orm`, `pg`, `zod` and `@pattern-stack/wiring`, the last built from `packages/wiring`. Nothing
   from `@nestjs` and no `reflect-metadata`.
2. Run `project init --runtime vendored`, set the target to pattern-stack, and delete every scaffolded file that imports
   `@nestjs`, naming each, before generating. Pattern-stack `project init` is PW-4.
3. Turn `experimentalDecorators` and `emitDecoratorMetadata` off, and run `entity new --all`.
4. Check:
   - no source file imports `@nestjs/*` or `reflect-metadata`, and neither is installed;
   - one `module.ts` per context, `<generated>/wiring.ts`, `<generated>/composition.ts` and a `.wiring.ts` per
     entity exist;
   - billing `dependsOn: ['crm']`;
   - there is no controller and no Nest module;
   - `tsc` passes, scoped by location only.

**The Postgres half, in the integration job.** `run-integration.ts` runs `run-smoke-pattern-stack.ts --postgres
<scaffold url>` after the Nest suite.
- The smoke creates a database of its own on that server, pushes the pattern-stack schema with drizzle-kit, and runs
  `src/crud-check.ts` (`test/smoke/fixtures-pattern-stack-usage/`).
- That file is a consumer's usage: a `database` system, `compose({ systems, modules: [...MODULES] })`, `start()`,
  then through the composed use cases:
  - create;
  - findById;
  - a joined-table child created through its base and read back;
  - a cross-module create (billing's `invoice` with crm's account);
  - list;
  - the declarative query;
  - update;
  - deletes;
  - a deleted id is a `NotFoundError` (404).
- Finally `stop()`, which ends the pool.
- The same file is copied in before `tsc`, so the compile half also type-checks every key it reads.

## Known for later

- PW-4: `project init` for pattern-stack writes no Nest scaffold and doesn't vendor `nest-logger.ts`. It writes
  `compose.ts`, the `database` system and `main.ts`.
- S-1: under pattern-stack, the event codegen must augment `…/events/core`, not `…/events/index` (PW-0's gap).
- From #965: one error-body owner. `runtime/errors.ts` gains 409 / 422, and a constraint violation becomes an
  `AppError`.
