# How deep NestJS and Drizzle go in codegen-patterns

Slice s1, research. 2026-11-25. Read against `checkouts/codegen-patterns/main` at `b04f1a8a` and crew at
`~/Farm/crew/checkouts/crew/s3-slice-1`. Paths without a prefix are in the codegen clone. Counts come from grep and
are exact unless marked "about"; costs in section 6 are estimates and say so.

## The answer

**NestJS is separable; Drizzle-on-Postgres is woven through.** Nest is mostly a skin: the generated classes are plain
TypeScript with Nest decorators on their constructors, the base classes they extend import no Nest (one `Logger`
aside), and the subsystems already have the protocol → backend shape with Nest modules as thin shells. What is Nest
all the way down is the HTTP layer (controllers, Swagger, guards) and two subsystems (jobs and auth). Drizzle is the
opposite. The column builders, the repository bodies, the base classes' generic types (`PgTable`, `NodePgDatabase`)
and the migration path all assume Drizzle on Postgres, and the generator mixes Drizzle text into the same records as
its neutral field data. There is **no target switch anywhere** today, but there is one clean seam to build on:
`src/derived/api/`, the name-and-existence model every template prints from (ADR-046). For crew specifically, the
gap is bigger than "no Nest": crew's rules are plain SQL, no ORM, synchronous `bun:sqlite`, Zod 4 and nested value
objects, and codegen emits async Drizzle, Zod 3 and flat rows with a uuid `id`.

## 1. Where NestJS is assumed

### Counts

Files that import `@nestjs/*` or use `@Injectable`, `@Module(`, `@Controller`, `@Inject(`, `DynamicModule` or a
lifecycle hook (tests excluded):

| Area | Files | With Nest |
|---|---|---|
| `templates/` (emitted code) | 91 | 31 |
| `runtime/` (shipped to the consumer) | 165 | 61 |
| `src/` (the generator) | 197 | 15 (27 with looser string matches such as `forRoot`) |
| `packages/`, `tools/studio/src` | 116 | 0 |

### In emitted code (`templates/`)

What one entity becomes, read from `test/baseline/packages/api/src/modules/contacts/` (16 files, 1,121 lines):

| File | Nest in it |
|---|---|
| `contact.entity.ts` | none (Drizzle `pgTable`) |
| `dto/*.ts` (4 files) | none: `import { z } from 'zod'` only |
| `contact.repository.ts` | `@Injectable()`, `constructor(@Inject(DRIZZLE) db)` (template: `templates/entity/new/backend/repository.ejs.t:6,365,473`) |
| `contact.service.ts` | `@Injectable()`, `@Optional() @Inject(EVENT_BUS)` property injection, constructor-injected sibling repositories |
| `use-cases/*.ts` | `@Injectable()`, `@Inject(DRIZZLE)`, `@Inject(TYPED_EVENT_BUS)`, `NotFoundException` |
| `contact.controller.ts` | all of it: `@Controller`, `@Get/@Post/…`, `ParseUUIDPipe`, `@nestjs/swagger` decorators, `ZodValidationPipe` |
| `contacts.module.ts` | all of it: `@Module`, `forwardRef(() => AccountsModule)`, `OnModuleInit` registering Zod schemas with the OpenAPI registry |

The class bodies are plain. The repository's base class has no Nest (`runtime/base-classes/base-repository.ts:10`:
"NOT @Injectable — concrete repositories are @Injectable and inject DRIZZLE"). The templates agent's estimate of
how much of each template is Nest-specific: repository about 3%, service about 8%, use cases 5–15%, controller about
60%, module about 80%. DTOs, `composed-base`, `index` and `_shared/*.mjs` have none.

Nest also lives in:
- `templates/junction/new/{repository,service,module}` and `templates/relationship/new/{repository,service,controller,module,use-cases}`;
- `templates/broadcast/new/*` (`@WebSocketGateway` in `websocket-backend.ejs.t`);
- `templates/subsystem/jobs/worker.ejs.t` (`NestFactory`), and the app-module and main hooks under `templates/subsystem/*`.

Barrels: `<generated>/modules.ts` exports `GENERATED_MODULES`, an array of Nest modules (ADR-017, `src/cli/shared/barrel-generator.ts`).

### In codegen's runtime (`runtime/`)

- **Base classes.** `base-repository.ts`, `base-service.ts`, `with-analytics.ts` and the family classes import no
  `@nestjs`. The one leak: `base-classes/lifecycle-events.ts:26` imports `Logger` from `@nestjs/common` as a value, and
  `base-service.ts:27` imports that file, so `BaseService` loads `@nestjs/common` for logging only.
- **Subsystems.** The Nest modules are mostly thin shells over plain constructors that already exist but aren't
  exported, e.g. `buildCacheAsync` in `subsystems/cache/cache.module.ts:48-63`. Real logic sits inside Nest in two
  places:
  - jobs: `JobWorkerOrchestrator` (`subsystems/jobs/job-worker.module.ts:149-300`) upserts job rows, spawns workers
    and resolves handlers through `ModuleRef`;
  - auth: `APP_GUARD`, `Reflector`, `SetMetadata`, an `AuthController`, and `auth/middleware/requester-context.ts`,
    which takes an `INestApplication`.
- **Lifecycle hooks with real work.** These start loops and open connections:
  - `events/event-bus.drizzle-backend.ts:198` (poll loop and `LISTEN`);
  - `events/events.module.ts:216-238` (scheduler);
  - `jobs/job-worker.ts:308,392`;
  - `jobs/job-worker.bullmq-backend.ts:85`;
  - `cache/cache.drizzle-backend.ts:42`;
  - `bridge/bridge.module.ts:175`;
  - `observability/reporters/bridge-metrics.reporter.ts:67`.

  Plain wiring would need start/stop for these.
- **Tokens.** These need no Nest. `constants/tokens.ts:15,29` are plain strings (`DRIZZLE`, `EVENT_BUS`). The ADR-037
  subsystem tokens are `Symbol.for('@pattern-stack/codegen.<area>.<name>')` (`subsystems/token-key.ts`). A typed map
  could carry all of them.
- **Nest-only helpers:**
  - `pipes/zod-validation.pipe.ts` (a `PipeTransform`);
  - `shared/logging/compact-console-logger.ts` (extends `ConsoleLogger`).

  `http/pagination.ts`, `http/includes.ts` and `shared/openapi/*` (5 files) are Zod or nothing.
- **Packaging.** `package.json`:
  - Required peers: `@nestjs/common ^10`, `@nestjs/core ^10`, `reflect-metadata`, `rxjs`, `drizzle-orm ^1.0.0-rc.4`.
  - Optional peers: `@nestjs/swagger`, `@nestjs/schedule`.
  - `runtime/subsystems/index.ts:14,48,53,59,171` re-exports the Nest modules, so importing the `subsystems` barrel
    loads `@nestjs/common`. Deep imports through `./runtime/*` avoid it.

### In the generator (`src/`)

- `src/cli/shared/init-scaffold.ts` writes the consumer's starting files, only when they are missing:
  - `database.module.ts`, a `@Global() @Module` providing `DRIZZLE` (line 260);
  - `app.module.ts` (line 312);
  - `main.ts` with `NestFactory` and Swagger (line 450);
  - a tsconfig with `experimentalDecorators` and `emitDecoratorMetadata` (about line 610).
- The integration layer is emitted by string-template generators in `src/cli/shared/`. These are not the
  `src/emitters/integration` that CLAUDE.md names, which doesn't exist. All of them emit Nest:
  - `adapter-emission-generator.ts:577-756`;
  - `assembly-emission-generator.ts:196-234`: `@Module`, `useFactory`, per-provider Symbol tokens;
  - `provider-module-generator.ts:146-160`;
  - `change-emitter-emission-generator.ts:105`;
  - `sink-emission-generator.ts`.
- Subsystem scaffolding: `events-`, `jobs-`, `auth-` and `bridge-scaffold-locals.ts`, `subsystem-barrel`,
  `ast-patch`, `project-upgrade-auth.ts` and `project-upgrade-openapi.ts`.
- `src/derived/api/names.ts:73-136` builds the class names `XController`, `XSearchController`, `<Plural>Module` and
  `…UseCase`. These are the Nest shape's names, but only names.

### Is there a seam?

No target or flavour switch exists. `codegen.config.yaml` is `.strict()` with these top-level keys:
`runtime, paths, generate, patterns, locations, frontend, auth, tenancy, tables, behaviors, dev, subsystems, events,
jobs, bridge, integration, observability, openapi, cache, storage` (`src/schema/codegen-config.schema.ts:799-821`).
ARCH-0 and ARCH-1 deliberately deleted the last architecture switch (`generate.architecture`, `database:`; CLAUDE.md
§ Backend Template Pipeline). What exists that a target could hang on:

- **`runtime: package | vendored`** (ADR-037, `src/config/runtime-mode.mjs`, `src/cli/shared/runtime-import.ts`). One
  table maps logical runtime paths to import specifiers. It is the right shape for a target table, but today it
  changes only *where* imports come from.
- **The hygen template root is a parameter**, `opts.templateRoot ?? defaultTemplateRoot()`
  (`src/cli/shared/hygen.ts:136`), but the generator/action pair `entity new` is hard-coded (`hygen.ts:197`).
- **`skip_if` gates already exist.** Per entity, `api: false` (`src/schema/entity-definition.schema.ts:1239-1249`) removes
  every route, and `controller.ejs.t:3` skips on `!apiSurface.http.enabled`. The use-case templates skip on their
  `outputPaths.*`. So "no HTTP" already exists per entity. It just still emits Nest modules and services.
- **`src/derived/api/`** is the real seam (section 4).

So Nest is **woven into the templates' text but not into the generator's model**: the Nest strings are in the EJS and
in a few `src/cli/shared` string builders, and the data they print from is mostly neutral.

## 2. Where Drizzle is assumed

Files mentioning Drizzle (`drizzle-orm`, `pg-core`, `pgTable`, `DrizzleClient`): 30 in `templates/`, 60 in
`runtime/`, 37 in `src/`. SQLite is named once, in `src/scanner/orm-detector.ts` (detection only). **Postgres is
hard-coded**, with no dialect anywhere.

- **Schema emission.**
  - `templates/entity/new/backend/entity.ejs.t:13` and `enums.ejs.t:8` import `drizzle-orm/pg-core`.
  - The primary key is always `uuid('id').primaryKey().defaultRandom()` (`entity.ejs.t:41`). The YAML has no other
    key shape and no composite primary key.
  - `PG_IDENTIFIER_MAX_BYTES = 63` (`entity-locals.js:1098`).
- **The locals builder mixes neutral and Drizzle data.** `templates/entity/new/backend/entity-locals.js` is 3,040
  lines:
  - About 700 lines build Drizzle text: `DRIZZLE_TYPE_MAP`/`DRIZZLE_IMPORT_MAP` (299-321), `buildDrizzleChain`
    (440-482), `renderColumnDefault` (499), `processFieldFeatures` (893), `processUniqueIndexes` (1034-1097),
    `collectDrizzleImports` (1161-1203), and the constraints block (about 2135-2420).
  - About 75 lines build Zod chains (`ZOD_TYPE_MAP` 327, `zodChainForCreate` 1206, `zodChainForOutput` 1236).
  - The rest, about 2,200 lines, is neutral.
  - The catch: `processFields` (535-608) returns `drizzleChain`, `zodType` and `tsType` in **one record**, so the
    neutral field facts and the Drizzle text are not separable yet. `prompt.js` (677 lines) also carries
    `drizzleType`/`zodType` strings in its behaviour registry (42-143), as do `src/behaviors/*` (`types.ts:27,29`).
- **Repositories.** `repository.ejs.t` is 1,124 lines; the templates agent estimates about 45% of it is Drizzle. It
  uses the relational query API (`this.db.query.contacts.findFirst({ with })`), `onConflict`, and `tx` threading.
  - `runtime/base-classes/base-repository.ts` (1,080 lines) is typed `TTable extends PgTable` (line 194) on
    `DrizzleClient = NodePgDatabase` (`runtime/types/drizzle.ts:27`). It uses `.returning()` (447, 468), raw
    `cast(count(*) as integer)`, `EXISTS` subqueries, and `requireRelationalQuery` (285-298).
  - 13 of 24 base-class files import Drizzle.
  - Upserts use `onConflictDoUpdate`: `integrated-entity-repository.ts:129`, `junction-integration-repository.ts:101`
    and `metadata-entity-repository.ts:72`.
  - `with-communication.ts` uses pg `unionAll` and `::text` casts.
- **Relations (`with` includes).**
  - `src/emitters/relations/emit-manifest.ts:230` emits Drizzle 1.0's `defineRelations` into `<generated>/relations.ts`.
  - The repository's include and column-mask types (`IncludeOf`, `ResultOf`, `ColumnsOf`) are typed off that manifest.
  - The graph itself (`buildRelationGraph`) is neutral.
- **Transactions.**
  - Use cases call `this.db.transaction(async (tx) => …)` and pass `tx` into the service (emitted
    `use-cases/create-contact.use-case.ts:27`).
  - The event bus protocol takes that same Drizzle `tx` (`runtime/subsystems/events/event-bus.protocol.ts:10`).
  - So the outbox is "in the same Postgres transaction" by type.
- **Tenancy.**
  - `runtime/base-classes/tenant-context.ts` is `AsyncLocalStorage` (`node:async_hooks`); it needs no Drizzle and runs
    on Node and Bun.
  - The scoping it drives (`scope-filters.ts`, ADR-042) builds Drizzle `where` clauses on `PgColumn`.
- **Semantic/query surface.**
  - `src/emitters/semantic/build-model.ts` builds a neutral `SemanticModel`.
  - `emit-model.ts:198-199` prints `getColumns` from `drizzle-orm` and `PgColumn`/`PgTable` for
    `@pattern-stack/query-surface`, an external package that is Postgres/Drizzle-typed.
- **Migrations.** There is no migration generator.
  - The schema reaches Postgres through `drizzle-kit push` (`src/cli/commands/dev.ts:40-52`) or Atlas reading the
    Drizzle schema (`docs/CONSUMER-SETUP.md` § Atlas). The barrels `<generated>/schema.ts` and `subsystems-schema.ts`
    exist for drizzle-kit.
  - The subsystems' own tables are `pgTable` templates: `templates/subsystem/*/*.schema.ejs.t` (4 files).
- **Postgres-only features in subsystems.** These have no SQLite equivalent:
  - `FOR UPDATE SKIP LOCKED` (job claim, events drain);
  - `pg_notify`/`LISTEN` (`events/event-bus.drizzle-backend.ts:298-314`, `jobs/pg-notify.ts`,
    `bridge-outbox-drain-hook.ts:241`);
  - `jsonb`.

**Is data access behind its own seam?** Partly. The repository *surface* (method names and kinds) is derived neutrally
in `src/derived/api/`. The repository *implementation* is Drizzle in both the template and the base classes. Drizzle
is not mixed into the Nest layer: it sits under it. The Nest decorators are a thin layer on top of Drizzle-typed
classes, so the two axes can be cut apart. The Drizzle one is the deep one.

## 3. What else is coupled to either

| Part | Coupling | Needs a twin for a non-Nest target? |
|---|---|---|
| `entity validate` (`src/cli/commands/entity.ts:1132-1196`) | none: schema, pattern and analyzer only. One Drizzle-version rule in `entity-definition.schema.ts:1405-1435` | no |
| Parser, analyzer, `src/patterns`, `src/roles` | none, except patterns carry base-class names and `@shared/base-classes/...` paths (`src/patterns/library/integrated.pattern.ts:20-23`) | patterns need per-target base-class names |
| `src/derived/api` | neutral data; Nest-shaped class-name suffixes (`names.ts:73-136`) and Drizzle base-class names pass through (`entity.ts:1033,1037`) | the name rules need a target dimension |
| Studio server (`src/studio/server/**`) | shells the CLI. One import: `drizzlePushPlan` from `dev.ts` (`server/runs.ts:23,196`). `tools/studio/tsconfig.json` sets `experimentalDecorators` because the analyzer's type chain reaches the decorated runtime | small: the push step is Postgres-only |
| CLI `dev` (`src/cli/commands/dev.ts`) | `drizzle-kit push` | yes, per data-access choice |
| `project init` (`init-scaffold.ts`) | writes Nest `app.module`/`main`/`database.module` and the decorator tsconfig | yes: one scaffold per composition × HTTP choice |
| Config (`codegen-config.schema.ts`) | subsystem `backend: drizzle \| memory \| bullmq` (lines 573, 635); no target key; `runtime` only picks import paths | a new key, the decision below |
| Events / typed events (EVT-7) | use cases inject `TYPED_EVENT_BUS` + `DRIZZLE`; the bus takes a Drizzle `tx` | the protocol's tx type must become neutral |
| Observability | Drizzle read-only facade; Nest module; metrics reporter on a lifecycle hook | later |
| Frontend emitter (`src/emitters/frontend/`) | reads derived HTTP routes (`emit-utils.ts:66-68`). No Nest or Drizzle import (`deps.ts` is a comment). `electric` sync assumes Postgres (Electric) | works with any HTTP layer that keeps the derived routes; dead with no HTTP |
| Scanner (`src/scanner/framework-detector.ts:11`, `orm-detector.ts:5`) | detects `nestjs \| fastify \| express \| plain` and `drizzle \| prisma \| typeorm \| none`, but **nothing branches on it**: `init-scaffold.ts:920-929` only prints it in a summary | could feed the default target later |
| Tests that pin output | 249 baseline files, 533 render-golden files, 44 api-surface-golden files, 119 smoke files; `src/__tests__` 342 files | a second target needs its own baseline and smoke at least |
| Zod | `zod ^3.22.4` is the one runtime dependency (`package.json:118`); crew is on Zod 4 | the emitted chains must target Zod 4 for crew |

## 4. The axes as they really are

| Axis | State | Where the cut goes |
|---|---|---|
| **Data access** | **Fused** to Drizzle + Postgres: field records, column text, repository bodies, base-class generics, relations manifest, migrations, subsystem tables | 1. split `processFields` into neutral field facts plus per-dialect rendering. 2. Make the base classes generic over the dialect, or give each data-access choice its own base classes. 3. Give the repository template one twin per choice |
| **Composition** | **Thin skin.** Decorators on plain classes, and module files that only list providers. Two deep spots: jobs (`ModuleRef`, orchestration in a provider) and auth (guards) | 1. A `wiring` template per entity in place of `module.ejs.t`. 2. Drop the decorators from repository, service and use cases. 3. Export the subsystems' plain factories. 4. Add start/stop for the lifecycle hooks |
| **HTTP** | **Separable, Nest-only today.** `controller.ejs.t` and `search-controller.ejs.t` are the HTTP layer. Routes are already derived data, and `api: false` already turns them off | 1. A Hono twin of the two controllers. 2. `ZodValidationPipe` becomes a validator middleware. 3. The OpenAPI registry is already Zod-only (`runtime/shared/openapi`) |
| **JS runtime** | **Mostly free already.** The generator itself runs on Bun (`bunx --bun hygen`, `hygen.ts:138`). Emitted code uses `node:async_hooks`, `process.on('SIGTERM')` and `drizzle-orm/node-postgres` | It rides on data access: the driver (`node-postgres`, `bun:sqlite`, `Bun.sql`) is the only real difference. A guess: Nest on Bun works but nobody here has tried it |

One more fusion to note. **Composition and data access meet at the transaction.** Use cases take the Drizzle client
by token to open a transaction and pass `tx` down through service and repository. They also hand the same `tx` to the
event bus. Whatever the second data-access choice is, the "transaction handle" type has to become a protocol type
before composition can be swapped cleanly.

## 5. The smallest useful first cut for crew

What crew wants (`crew/docs/DESIGN.md` "Settled" 2–3, "The repositories"; `sqlite.teams-store.ts`; `teams.sql`):

- **Plain SQL, no ORM, and Zod as the only runtime dependency.** "every row checked against the model schemas both
  ways; plain SQL, no ORM" (DESIGN.md § The repositories); "zod is the only runtime dependency" (architecture rule 6).
- **Synchronous repositories.** `AgentRepository.get(address): Agent | undefined`
  (`modules/teams/domain/agent.repository.ts`), over `SqlHandle { run, get, all, exec }`
  (`core/database/database.protocol.ts`).
- **Nested domain objects on flat columns.**
  - `address {project, team, agent}` becomes three columns; `work {system, ref}` becomes two nullable columns.
  - Composite primary keys: `PRIMARY KEY (project, id)` and `UNIQUE (project, team, agent)`.
  - An autoincrement `seq` for ordering.
- **A compare-and-set move** on `rev` (`UPDATE … WHERE … AND rev = ?`, `changes === 1`).
- **Null handling.** Null drops to a missing field (`present()`); booleans are stored as 0/1.
- **One `.sql` per module**, run by the store (`CREATE TABLE IF NOT EXISTS`).
- **Zod refinements and transition tables** live in the domain file (`domain/agent.ts`), not in storage.

### What codegen would emit for this cut

All of these are new templates under a second template root, which `hygen.ts:136` already allows:

1. **`<entity>.schema.ts`.** A Zod 4 object for the row-level record, built from `zodChainFor*`
   (`entity-locals.js:1206,1236`), retargeted to Zod 4 (`z.uuid()` and so on).
2. **`<entity>.sql`.** SQLite DDL: tables, unique sets and indexes, from the *neutral half* of `processFields`. Today's
   `buildDrizzleChain` text can't be reused.
3. **`sqlite.<entity>-store.ts`.**
   - Row interface, `toX(row)` and `fromX(x)` mapping, and `get`/`list`/`add`.
   - The FK finders and unique finders named by `src/derived/api` (`RepositoryMethod.kind` `find_by_id`,
     `fk_finder`, …).
   - An optional `move` when the entity declares a rev column.
   - Written against a `SqlHandle`-shaped protocol: crew's, or a copy shipped in codegen's runtime.
4. **`<entity>.repository.ts`.** The interface alone, so crew's conformance suites (`assert-<name>-repositories.ts`)
   can target it.

### What it would skip

Controllers, modules, services, use cases, the integration layer, events, subsystems, the relations manifest, the
semantic model, the frontend, the OpenAPI registration, `drizzle-kit`, and every family base class (integrated,
activity, metadata, inheritance, EAV).

### What it reuses

- the parser and schema validation;
- the analyzer and `buildRelationGraph`;
- `src/derived/api` names;
- `src/config/file-naming.ts` and `table-naming.ts`;
- the `@generated` banner (`templates/_shared/generated-banner.mjs`);
- the barrel idea (ADR-017);
- `entity validate`, and Studio for viewing.

### What the YAML can't say yet

These matter as much as the templates:

- **Composite primary keys.** The id is always a uuid (`entity.ejs.t:41`).
- **Value objects.** A nested `address` or `work` is flattened to columns.
- **A `rev` compare-and-set column.**
- **A store-assigned `seq`.**
- **Booleans stored as 0/1** (a SQLite concern).
- **State enums with transitions** (crew keeps those in `defineTransitions`, outside storage).

Without value objects and composite keys, codegen could emit crew's *row* layer but not its *domain* types, and crew
would hand-write the mapping it hand-writes now. The cut would save the DDL, the row interface and the CRUD SQL: about
half of `sqlite.teams-store.ts` (231 lines), going by its shape.

### The alternative cut: Drizzle on SQLite

Keep the Drizzle pipeline and add a `sqliteTable` dialect. This reuses much more of codegen: repository bodies,
relations and includes, tenancy. But:

- it breaks crew's "no ORM" and "zod only" rules;
- it is async where crew is sync;
- it needs the base classes made dialect-generic first.

It is the better first step for codegen's *other* users and the worse one for crew.

## 6. Cost, honestly

Counts of files are measured; line estimates are mine unless marked.

| Axis, second choice | Touches | Risky parts |
|---|---|---|
| **Composition: plain wiring** | **Templates:** repository, service, the 9 use-case templates, module (replaced), index, and the junction/relationship equivalents. About 20 templates, but only a few lines each outside `module.ejs.t` (152 lines). **Generator:** barrel-generator, init-scaffold's 3 content builders, the 5 integration emission generators. **Runtime:** `lifecycle-events.ts` Logger; export the plain factories from the subsystem module files. Guess: about 1–1.5k lines changed for entities, plus jobs and auth | 1. `forwardRef` cycles between entity modules (`contacts.module.ts`). Crew's `orderByNeeds` **throws on a cycle** (`wiring.ts`), so the entity graph's cycles need an answer: lazy getters, or repositories wired before services. 2. `@Optional()` property injection of the event bus. 3. Jobs' `ModuleRef` handler lookup and the boot-time orchestrator (about 300 lines to restate). 4. Lifecycle hooks become an explicit start/stop. 5. Two output shapes to keep under goldens |
| **HTTP: Hono** | `controller.ejs.t` (286) and `search-controller.ejs.t` (72) get twins. `ZodValidationPipe` becomes middleware. Auth guards become Hono middleware (`runtime/subsystems/auth/guards/*`, `requester-context.ts`). Swagger decorators become route metadata on the existing Zod OpenAPI registry. Guess: about 600–900 lines new | Auth guard parity; OpenAPI output parity; the `include` query parsing (`runtime/http/includes.ts` is already plain) |
| **HTTP: none** | Already exists per entity (`api: false`). As a target it also drops the controller template, OpenAPI registration and `main.ts` | Small |
| **Data access: Drizzle SQLite dialect** | `entity-locals.js` Drizzle helpers (about 700 lines), `entity.ejs.t`, `enums.ejs.t`, about 45% of `repository.ejs.t`, the 13 Drizzle-importing base-class files (generics), `types/drizzle.ts`, `emit-manifest.ts`, `semantic/emit-model.ts`, 4 subsystem schema templates, `dev.ts`. Guess: 3–5k lines touched | `with-communication`'s pg casts; `uuid`/`jsonb`/`text[]` (`string_array`) mapping; Drizzle 1.0 rc relational-query types across dialects; events and jobs depend on `SKIP LOCKED` and `LISTEN`, so they need different backends, not just a dialect |
| **Data access: Kysely** | All of the above, plus repository bodies rewritten (no relational `with` API, so includes are built by hand) and every base class rewritten. Guess: 6–10k lines, the largest piece by far | Typed includes and column masks (READ-1) have no Kysely equivalent; tenancy scoping rewritten; every golden re-pinned |
| **Data access: plain SQL (the crew cut)** | New: 3–4 templates and a neutral split of `processFields`. Guess: 800–1,500 lines new; nothing existing changes except the split | YAML gaps (composite keys, value objects, rev); a second, much smaller feature set that must say clearly what it doesn't support (no includes, families, upserts or tenancy) |
| **JS runtime: Bun** | Rides on data access: a `bun:sqlite` or `Bun.sql` driver, and a Bun smoke test. Guess: small | Nest on Bun is untested here; `reflect-metadata` and decorator metadata under Bun are the thing to check (I haven't) |

Where I'm guessing:
- every line count in the "Touches" column that says "guess";
- that Nest boots on Bun;
- that crew's store is about half generatable.

The file counts, template sizes and line references are measured.

## Recommended order of work

1. **Split the field model.** Make `processFields` (`entity-locals.js:535-608`) return neutral facts, then render
   Drizzle and Zod from them. This continues ADR-046's own plan ("later slices add `columns/` and `wiring/`", ADR-046
   § Decision), so it fits codegen's rules and can be gated byte-identical on today's goldens. Every axis needs it.
2. **Add a target key** with one value, today's behaviour, and route the template root and `runtime-import.ts`
   through it. This is a no-op that gives later choices somewhere to live. Per crew's rule, no abstraction for the
   second choice until it exists.
3. **Crew's cut: plain-SQL SQLite stores.** Zod 4 schema, `.sql`, a row store over `SqlHandle`, and the repository
   interface, for one crew module (teams). It passes when crew's `assert-teams-repositories` passes against the
   generated store. This proves the data-access axis has two choices.
4. **Composition: plain wiring** from `wiring.ts`, lifted into a package, for the Nest pipeline's own entities. Do
   it after (3), so crew's wiring has a second consumer before it's lifted.
5. **HTTP: Hono**, when a consumer asks for it.
6. **Kysely or Drizzle-SQLite** only if a consumer needs the full feature set (includes, families, tenancy) off
   Postgres.

### What Doug must decide

1. **Plain SQL or Drizzle-on-SQLite for crew's cut.** Crew's rules say plain SQL. Drizzle-on-SQLite reuses far more of
   codegen. Pick per consumer, or one?
2. **Does the entity YAML grow** composite keys, value objects and a compare-and-set `rev`, or does codegen emit only
   the row layer and leave crew's domain types hand-written?
3. **Sync or async repository protocol** for a non-Postgres target. Crew is sync; everything in codegen is async.
4. **Zod 4.** Move codegen to Zod 4 everywhere, or emit Zod 4 only for the new target?
5. **Where `wiring.ts` lives** once lifted (its own package, or inside `@pattern-stack/codegen`), and what to do about
   entity-module cycles, which it refuses today.
6. **Is step 1 (the field-model split) a codegen-patterns PR now?** It touches the active Relations v2 project's
   files (`entity-locals.js`), so it needs the #578 charter's invariants (CLAUDE.md § Active project).
