# Consumer Setup

The contract a consumer project must satisfy for generated code to compile and run. If you just want to generate a first entity in this repo, read [GETTING-STARTED.md](./GETTING-STARTED.md) instead — this doc is for the second step: wiring `@pattern-stack/codegen` into a separate NestJS + Drizzle project you own.

A complete working example lives at [`codegen-pattern-demo-app/`](https://github.com/pattern-stack/codegen-pattern-demo-app) — every file referenced below has a real counterpart there.

## Who this is for

You are running `@pattern-stack/codegen` (installed as a dependency, or as the `npx @pattern-stack/codegen` binary — see [ADR-015](./adrs/ADR-015-cli-command-architecture.md)) against your own NestJS application. This doc tells you what `codegen project init` writes, what you install, and what the generated code expects of the rest of the app.

## Prerequisites

- **Bun** 1.0+ or **Node** 20+
- **NestJS** 10, on Express (`@nestjs/platform-express`)
- **Drizzle ORM** on the 1.0 line — `drizzle-orm@1.0.0-rc.4`, a peer you install (see [Drizzle in a generated project](./consumer/drizzle.md))
- **Zod 4** — `zod@^4.6.7`. The generated DTOs, the validation pipe and the OpenAPI registry are Zod 4 (ZOD-1;
  upgrading an app generated before 0.35.0: [MIGRATION-zod4.md](./MIGRATION-zod4.md))
- **TypeScript** 5+ with `"strict": true` and decorator metadata enabled
- A running Postgres you can point at with a `DATABASE_URL`

## Start a project

```bash
bun init -y                                   # or your own package.json + tsconfig.json
bun add @pattern-stack/codegen
bunx codegen project init --yes --with-tsconfig
bun add @nestjs/common@10 @nestjs/core@10 @nestjs/platform-express@10 @nestjs/swagger@7 drizzle-orm@1.0.0-rc.4 pg@8 reflect-metadata@0.2 rxjs@7 zod@4
bun add -D drizzle-kit@1.0.0-rc.4 typescript@5 @types/pg@8
# write entities/<name>.yaml, then:
bunx codegen entity new --all
bunx tsc --noEmit
DATABASE_URL=postgres://… bunx drizzle-kit push   # dev loop; versioned migrations: see "Atlas migration workflow"
DATABASE_URL=postgres://… bun src/main.ts
```

The two `bun add` lines are the whole install (npm / pnpm: the same packages). `@nestjs/platform-express` is not a
peer of the package, but the `main.ts` init writes boots on it. `codegen project init` prints the same two lines when
it finishes. (`codegen init` is an alias of `codegen project init`.)

`main.ts` refuses to serve an unauthenticated data plane: bind an `IUserContext` (install the auth subsystem), or set
`auth: { devAllowAnonymous: true }` in `codegen.config.yaml` and regenerate, **for localhost only**. To serve
`/docs` + `/docs-json`, set `openapi: { enabled: true }` the same way ([OpenAPI](./consumer/openapi.md)).

## Project structure expected

What `codegen project init` writes (the default `runtime: package`, `paths.backend_src: src`) and where generated
code lands:

```
<project-root>/
├── codegen.config.yaml            # generator config — starts with the editor-schema line and `target:`
├── drizzle.config.ts              # drizzle-kit config (push / generate / export), pointed at the schema barrel
├── tsconfig.json                  # merged: @shared/*, @modules/*, @generated/* aliases + decorator flags
├── entities/                      # your YAML entity definitions (input)
│   └── account.yaml
└── src/
    ├── app.module.ts              # wires DatabaseModule + OpenApiModule + GENERATED_MODULES (yours after init)
    ├── main.ts                    # Nest bootstrap + Swagger (yours after init)
    ├── schema.ts                  # one-line re-export of the generated schema barrel
    ├── shared/
    │   └── database/database.module.ts   # provides DRIZZLE (yours after init)
    ├── modules/                   # backend output: one folder per entity
    │   └── accounts/
    └── generated/                 # codegen owns this tree — don't edit
        ├── modules.ts             # GENERATED_MODULES barrel
        ├── schema.ts              # Drizzle schema barrel
        ├── relations.ts           # Drizzle 1.0 relations manifest
        └── app-config.ts          # boot values from codegen.config.yaml (openapi, auth, jobs)
```

Codegen owns `<paths.generated>/*` (default `src/generated/`) and the per-entity `src/modules/<plural>/` trees.
Init writes the other files once and never overwrites them without `--force`; after that they are yours.

In `runtime: package` the generated code and these files import the runtime from the package
(`@pattern-stack/codegen/runtime/...`, `@pattern-stack/codegen/subsystems`), so nothing is copied into your tree.
`runtime: vendored` (`project init --runtime vendored`) instead copies the runtime into `src/shared/` and imports it
through `@shared/*` — see [`src/shared/` vendored runtime files](#srcshared-vendored-runtime-files-runtime-vendored).

## tsconfig path aliases

Generated code imports its own trees through `@modules/*` and `@generated/*` (and, in `runtime: vendored`,
`@shared/*`). `project init` merges these into an existing `tsconfig.json` (or writes one with `--with-tsconfig`):

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "paths": {
      "@shared/*": ["./src/shared/*"],
      "@modules/*": ["./src/modules/*"],
      "@generated/*": ["./src/generated/*"]
    }
  },
  "include": ["src/**/*", "drizzle.config.ts"]
}
```

A merge into a `bun init` tsconfig also sets `verbatimModuleSyntax: false`, which decorator metadata needs.

## A project without NestJS (`--wiring pattern-stack`)

```bash
bun init -y
bun add @pattern-stack/codegen
bunx codegen project init --yes --with-tsconfig --wiring pattern-stack
bun add @pattern-stack/wiring drizzle-orm@1.0.0-rc.4 pg@8 zod@4
bun add -D drizzle-kit@1.0.0-rc.4 typescript@5 @types/pg@8
# write entities/<name>.yaml, then:
bunx codegen entity new --all
bunx tsc --noEmit
DATABASE_URL=postgres://… bunx drizzle-kit push
DATABASE_URL=postgres://… bun src/main.ts
```

`--wiring pattern-stack` writes `target: { wiring: pattern-stack, http: none }`, and no Nest scaffold: no
`DatabaseModule`, `app.module.ts`, Nest `main.ts` or modules barrel, no vendored file that imports `@nestjs/*`, and no
decorator flags in `tsconfig.json`. In their place:

| File | What it is | Owner |
|---|---|---|
| `src/database.ts` | `databaseSystem(url)`: the `database` system (`{ db }`), a Drizzle client over a `pg` pool that ends on stop | you |
| `src/compose.ts` | `composeApp()`: the systems and every generated module (`MODULES`), composed with `@pattern-stack/wiring` | you |
| `src/main.ts` | compose, `start()`, `run(app)`, `stop()`; SIGINT / SIGTERM stop the app first. Replace `run` with the app's work | you |
| `src/generated/{wiring,composition,openapi}.ts` | the composition, empty until the first entity; `entity new` rewrites it | codegen |

Read a module with `app.module('<context>')` (one module per entity `context:`) and call its use cases. There is no HTTP
layer yet.

**Events.** `bunx codegen subsystem install events` (drizzle or memory backend) vendors the Nest-free events runtime.
The next `entity new` writes the typed bus and an `events` system, `<generated>/events-system.ts`. That system is
listed in `SYSTEMS` (`<generated>/composition.ts`), which `compose.ts` composes after the database. A use case of an
entity with `emits:` publishes in its write's transaction. The drain loop starts on `app.start()`; subscribe with
`app.system('events').typed.subscribe('<event>', handler)` before then. The other subsystems are refused under
pattern-stack wiring until their own step.

## A SQLite project (`target: { database: sqlite, orm: drizzle }`)

TGT-2b. A SQLite target emits the **storage layer**: per entity, a Drizzle `sqliteTable` module
(`<module>/<entity>.entity.ts`) and its SQLite DDL (`<module>/<entity>.sql`), plus the schema barrel
(`<generated>/schema.ts`). It has no NestJS layer (repository, service, controller, module, DTOs, use cases) and no
Nest post-steps: `entity new` says what it skipped. Those come with `wiring: pattern-stack`.

```yaml
# codegen.config.yaml
target:
  database: sqlite
  orm: drizzle
```

- **Apply the DDL** at start-up: concatenate every `<entity>.sql` and run it (`CREATE … IF NOT EXISTS`, so it can run
  again). SQLite checks foreign keys on write, so file order doesn't matter. Turn `PRAGMA foreign_keys = ON` on per
  connection.
- **Query through Drizzle** with the generated tables. On Bun, `drizzle-orm/sqlite-proxy` over your connection works
  well; its callback must return rows as **positional arrays** (`Statement.values()`), not objects.
- **Storage:**
  - instants are ISO 8601 TEXT, and decimals are TEXT (exact strings; ordering by one is lexical);
  - booleans are INTEGER 0/1, and JSON and arrays are TEXT;
  - enums are TEXT with a `CHECK`, except an enum array, which has none on SQLite;
  - `max_length` is a `CHECK`;
  - ids are app-made uuids (TEXT);
  - a tenant-scoped NULLS NOT DISTINCT unique is a unique index over `ifnull(col, X'00')`.

## `DatabaseModule` contract

Every generated repository expects the `DRIZZLE` injection token to resolve to a Drizzle client. `project init` writes
this `@Global()` module (`runtime: package`):

```ts
// src/shared/database/database.module.ts
import { Module, Global } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DRIZZLE } from '@pattern-stack/codegen/runtime/constants/tokens';
import { relations } from '../../generated/relations';

export { DRIZZLE };
export type DrizzleDB = NodePgDatabase<typeof relations>;

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/app_dev',
        });
        return drizzle({ client: pool, relations });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
```

Requirements the generator relies on:

1. **`@Global()`** — generated repositories don't import `DatabaseModule` themselves; they inject `DRIZZLE` directly. Only a global provider satisfies that.
2. **Provides `DRIZZLE`** — the exact token from the runtime (`@pattern-stack/codegen/runtime/constants/tokens`; `@shared/constants/tokens` in `runtime: vendored`).
3. **Exports `DRIZZLE`** — so other modules can consume it.
4. **Client constructed with the 1.0 config object and the relations manifest** — `drizzle({ client: pool, relations })`. Drizzle 1.0 **removed** `schema` from the pg config; its generic slot is the `defineRelations()` manifest, which codegen emits to `<paths.generated>/relations.ts` on every `entity new` (REL-1). It is what types `db.query.<table>.findMany({ with: … })` and the generated include reads. See [Drizzle in a generated project](./consumer/drizzle.md).

## `DRIZZLE` injection token

Generated repositories do this:

```ts
constructor(@Inject(DRIZZLE) db: DrizzleClient) { super(db); }
```

`DRIZZLE` is the runtime's token — the string literal `'DRIZZLE'`, imported from
`@pattern-stack/codegen/runtime/constants/tokens` (or the vendored `@shared/constants/tokens`). Do not declare a fresh
token in your project: it must be the same identity as the runtime's, or `useFactory` will bind to one symbol and
`@Inject()` will look for another.

## `src/shared/` vendored runtime files (`runtime: vendored`)

**Only in `runtime: vendored`.** In the default `runtime: package` nothing below is written: generated code imports
these files from the package.

In `runtime: vendored`, generated code imports from stable `@shared/*` paths. Those paths have to resolve to something — the "something" is a **vendored copy** of the relevant runtime files in your `src/shared/` tree. `codegen project init --runtime vendored` writes these files for you on first run.

**Why vendor instead of re-export.** The naive approach is a one-line re-export from `codegen-patterns/runtime/...`. TypeScript treats identical types coming from different `node_modules` trees as distinct — two `PgTable<...>` values fail to unify even at identical `drizzle-orm` versions (the private `shouldInlineParams` field is the giveaway). A re-export shim compiles the consumer's generated code against two separate drizzle type graphs (its own and the runtime's), producing 20+ "Types have separate declarations of a private property 'shouldInlineParams'" errors. Vendoring bakes the runtime files into the consumer's own module graph, so only one drizzle-orm identity exists. See [ADR-017](./adrs/ADR-017-barrel-files-over-injects.md) for the broader "stable surface over inject" philosophy these vendored files extend.

`codegen project init --runtime vendored` writes the following files. You do not need to hand-author them — this list exists so you know what's generated and can spot-check the output.

### Base classes + transitive deps

```
src/shared/base-classes/base-repository.ts
src/shared/base-classes/base-service.ts
src/shared/base-classes/integrated-entity-repository.ts
src/shared/base-classes/integrated-entity-service.ts
src/shared/base-classes/activity-entity-repository.ts
src/shared/base-classes/activity-entity-service.ts
src/shared/base-classes/metadata-entity-repository.ts
src/shared/base-classes/metadata-entity-service.ts
src/shared/base-classes/knowledge-entity-repository.ts
src/shared/base-classes/knowledge-entity-service.ts
src/shared/base-classes/with-analytics.ts
src/shared/base-classes/lifecycle-events.ts       # transitive dep of base-service
src/shared/base-classes/base-read-use-cases.ts
```

### Types + constants

```
src/shared/types/drizzle.ts
src/shared/constants/tokens.ts
```

### Event bus protocol

```
src/shared/subsystems/events/event-bus.protocol.ts  # transitive dep of base-service + lifecycle-events
```

### Runtime validation pipe

```
src/shared/pipes/zod-validation.pipe.ts             # @Body() validation for generated write routes
```

Generated controllers wrap their `@Body()` params with `new ZodValidationPipe(CreateXSchema)` — the pipe runs the DTO's Zod schema at request time, throws `BadRequestException` on failure, returns parsed data on success. No consumer wiring required.

### EAV helpers

```
src/shared/eav-helpers.ts                           # toEavRows + mergeEavRows for eav_value_table services
```

Pure helpers used by services generated for entities declaring `eav_value_table: true`. Caller supplies the field-definition id/key maps; helpers are sync + allocation-light.

**Keeping vendored files in sync with the runtime.** After you upgrade
`@pattern-stack/codegen`, run `codegen update` (see [Updating](#updating-pattern-stackcodegen))
to re-sync these files to the new package version. Treat the vendored files as
generated output — don't hand-edit them; if you need to override behavior,
subclass them in your own module instead.

## Updating `@pattern-stack/codegen`

The package vendors three kinds of file into your project: the shared runtime
(`src/shared/**` base classes, types, the `DRIZZLE` token, the Zod pipe, the
OpenAPI registry), the runtime of any subsystem you installed
(`<subsystems-root>/<name>/`), and the agent skills (`.claude/skills/`, see
below). After a version bump they're all stale. Re-sync them in one step:

```bash
bun add @pattern-stack/codegen@latest
codegen update                 # re-sync runtime + installed subsystems + skills
codegen update --dry-run       # preview what would change first
```

`codegen update`:

- **Overwrites divergent package-owned files** with the new version (the
  cross-version delta is a content diff). It is gated on git-cleanliness — if a
  target has uncommitted changes it refuses unless you pass `--force`, so an
  update never mixes with your work-in-progress. Review the result via `git
  diff`.
- **Never touches files you own** — `codegen.config.yaml`, `app.module.ts`,
  `main.ts`, `database.module.ts`, entity YAML, or the generated barrels.
- **Refreshes only what's installed** — it re-syncs files already present for a
  subsystem; it does not install a subsystem you never added (that's `subsystem
  install`).

Flags: `--dry-run`, `--force`, `--skip-skills`, `--skip-subsystems`, `--json`,
`--cwd <path>`.

**Known limitation — schema shape changes.** `codegen update` re-syncs runtime
*source*, but the tenancy-gated Drizzle schema files (`domain-events.schema.ts`,
`integration-audit.schema.ts`, etc.) are generated by templates, not copied, so they
are **not** refreshed. If a subsystem's schema *shape* changed across versions,
re-run that subsystem's install to re-emit the schema, then cut an Atlas
migration:

```bash
codegen subsystem install <name> --force --force-config
```

## Agent skills

`codegen project init` (and `codegen update`) vendor a set of consumer-facing
Claude Code skills into `.claude/skills/`. They teach a coding agent how to use
this package in your project — authoring entities, wiring subsystems in the
right `forRoot` order, writing `@JobHandler` classes, the event-to-job bridge,
and external integration. They're auto-discovered by Claude Code from `.claude/skills/`.

```bash
codegen skills install         # (re)vendor the skills into .claude/skills
codegen skills install --dry-run
codegen skills list            # available vs installed
codegen project init --no-skills   # scaffold without vendoring skills
```

Treat them as generated output — don't hand-edit; each file carries a
`managed by @pattern-stack/codegen` header and `codegen update` overwrites
divergent copies. Commit them so your team's agents pick them up.

## `schema.ts` wiring

`project init` writes `<backend_src>/schema.ts`, a one-line re-export of the generated barrel — the schema root for
code that wants every table:

```ts
// src/schema.ts
export * from './generated/schema';
```

The generator writes `src/generated/schema.ts` on every run — do not edit it, do not include additional tables there.
The `drizzle.config.ts` init writes points drizzle-kit at that barrel (`schema: './src/generated/schema.ts'`). If you
have hand-authored tables outside the codegen entity set, re-export both from `src/schema.ts` and point
`drizzle.config.ts`'s `schema:` at it instead:

```ts
export * from './generated/schema';
export * from './shared/database/auth-tables'; // hand-authored
```

## Atlas migration workflow

Your schema lives in `src/generated/schema.ts` (re-exported by `src/schema.ts`). To promote schema changes into your database, use [Atlas](https://atlasgo.io/) — it inspects the Drizzle schema, diffs it against the database, and emits **versioned, reviewable** SQL migrations that you commit alongside the code change.

**Why Atlas, not `drizzle-kit push`.** `drizzle-kit push` is a dev-loop convenience — it applies schema changes directly, produces no migration file, leaves no reviewable artifact, and silently runs destructive operations. That is acceptable for throwaway iteration; it is **not** acceptable for shared databases, CI, or production. Atlas gives you:

- A `migrations/` directory of timestamped SQL files you review in PRs.
- Destructive-change detection (50+ analyzers for drops, data-loss renames, etc.).
- A forward-and-rollback workflow; migrations apply or fail atomically.
- CI-friendly `atlas migrate lint` that fails the build on risky diffs.

### Prerequisites

- **Atlas CLI** `>= 0.24.0` — install once per workstation / CI image:
  ```bash
  # macOS (Homebrew)
  brew install ariga/tap/atlas

  # Linux / CI / anywhere with curl
  curl -sSf https://atlasgo.sh | sh
  ```
  Verify with `atlas version`.
- A reachable `DATABASE_URL` (local Postgres is fine; the generated SQL is database-agnostic for the columns codegen emits).
- `drizzle-kit` (1.0 line) installed as a dev dependency, and the `drizzle.config.ts` `project init` writes — Atlas runs `drizzle-kit export`, which prints your schema as SQL DDL (no additional Drizzle plugin required).
- An empty **dev database** Atlas can use as scratch space to normalize that SQL (`dev =` below); a throwaway database on the same Postgres is fine, or `docker://postgres/16/dev`.
- An `atlas.hcl` file at your project root (next to `drizzle.config.ts`).

### Example `atlas.hcl`

Drop this at the project root and commit it. Atlas reads the schema by running `drizzle-kit export` (which reads
`drizzle.config.ts`) — no duplication of your Drizzle wiring.

```hcl
data "external_schema" "drizzle" {
  program = ["bunx", "drizzle-kit", "export"]
}
env "local" {
  src = data.external_schema.drizzle.url
  dev = getenv("ATLAS_DEV_URL")   # an EMPTY scratch database, e.g. postgres://…/atlas_dev?sslmode=disable
  url = getenv("DATABASE_URL")
  migration {
    dir = "file://migrations"
  }
}
```

drizzle-kit 1.0 has no `introspect:pg` (its commands are `generate`, `migrate`, `pull`, `push`, `export`); `pull`
reads a database, not your schema, so it is not the source here. Check the wiring with
`atlas schema inspect --env local --url env://src` — it prints the tables your entities define.

Swap `bunx` for `npx` if your project uses npm/pnpm. Add more `env "…"` blocks (e.g. `env "ci"`, `env "prod"`) as you grow — they all share the same `data "external_schema"` source.

### Workflow

1. **Author or update your Drizzle schema** (either by editing entity YAML and regenerating, or by authoring a hand-written table outside the codegen tree).
2. **Diff against the database** to produce a migration file:
   ```bash
   atlas migrate diff --env local --name add_account_flag
   ```
   This writes `migrations/<timestamp>_add_account_flag.sql` — one forward-only SQL file per change. The `--name` is a short human label; pick something a reviewer can grep for.
3. **Review the generated SQL.** Atlas is conservative but not omniscient — it cannot distinguish a column rename from a drop-and-add, so destructive changes always need a human look. Edit the file by hand if you need to preserve data (e.g. add a `UPDATE ... SET ...` before a `DROP COLUMN`).
4. **Apply the migration** against your target environment:
   ```bash
   atlas migrate apply --env local
   ```
   Atlas records every applied migration in an `atlas_schema_revisions` table so re-runs are no-ops. Failures roll back atomically.
5. **Commit the migration file** alongside the schema / YAML change in the same PR. The `migrations/` directory is part of your source tree; reviewers should see schema change and SQL change together.

In CI, add `atlas migrate lint --env local --latest=1` before merge to catch destructive diffs before they ship. In production, `atlas migrate apply --env prod` runs the same file set, ensuring dev and prod converge on identical schema.

## Subsystems

Each infrastructure subsystem has its own focused reference — install it with `codegen subsystem install <name>`. Events, jobs, bridge, integration and observability are composed for you: the regenerated `<paths.generated>/subsystems.ts` exports `SUBSYSTEM_MODULES` (spread once into `AppModule.imports`, after `DatabaseModule`), in the right order, configured by each subsystem's `codegen.config.yaml` block — do not register them again in `app.module.ts`. Cache, storage and auth are registered by hand (`CacheModule.forRoot(...)`, `StorageModule.forRoot(...)`, `AuthModule.forRoot(...)`); the install prints the call. Open the one you need; in-project coding agents get the same material, progressively disclosed, from the vendored `.claude/skills/` (see [Agent skills](#agent-skills)).

### Events subsystem

Transactional-outbox event bus: the `IEventBus` protocol, Drizzle + Memory backends, the generated `TypedEventBus` facade, authoring events as YAML, and entity `emits:` integration.

**Read [`consumer/events.md`](consumer/events.md)** when authoring a domain event, publishing inside a DB transaction, or registering `EventsModule`.

### Bridge subsystem

The durable, typed event-to-job bridge: the three reaction tiers, the reserved `events_*` pools (`BRIDGE_RESERVED_POOLS`), authoring `@JobHandler.triggers`, ordering, and the `codegen events consumers` fanout report.

**Read [`consumer/bridge.md`](consumer/bridge.md)** when running a job in reaction to an event, wiring the reserved pools, or choosing between an in-process subscriber / `publishAndStart` / a bridge trigger.

### Integration subsystem

The external-system integration engine: the `IChangeSource<T>` port (poll / CDC / webhook), `IIntegrationSink<T>`, `ExecuteIntegrationUseCase`, per-entity feature modules, the `detection:` config block, and the structured `changed_fields` audit log.

**Read [`consumer/integration.md`](consumer/integration.md)** when pulling or pushing data between your database and an external system (CRM, etc.).

### Auth subsystem

OAuth integration auth: the `OAuth2RefreshStrategy` template-method base, token-at-rest encryption, the OAuth state-store port, `withAuthRetry`, and the integration-store ports your app supplies.

**Read [`consumer/auth.md`](consumer/auth.md)** when wiring `AuthModule`, implementing a provider OAuth strategy, or refreshing tokens.

### OpenAPI subsystem

Swagger / OpenAPI surfacing: the `/docs` + `/docs-json` routes, the `openapi:` config block, BearerAuth, registering custom schemas on the `OPENAPI_REGISTRY`, and the Zod→OpenAPI mapping gotchas.

**Read [`consumer/openapi.md`](consumer/openapi.md)** when exposing API docs, customizing the OpenAPI document, or registering a non-entity schema.

## `app.module.ts` wiring

`AppModule` imports the `DatabaseModule` first, then the `@Global()`
`OpenApiModule` that provides the registry, then spreads the generated
module barrel:

```ts
// src/app.module.ts
import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from './shared/database/database.module';
import { GENERATED_MODULES } from './generated/modules';
import { OPENAPI_REGISTRY, OpenApiRegistry } from '@pattern-stack/codegen/runtime/shared/openapi'; // vendored: './shared/openapi'

@Global()
@Module({
  providers: [{ provide: OPENAPI_REGISTRY, useValue: new OpenApiRegistry() }],
  exports: [OPENAPI_REGISTRY],
})
class OpenApiModule {}

@Module({
  imports: [DatabaseModule, OpenApiModule, ...GENERATED_MODULES],
})
export class AppModule {}
```

`DatabaseModule` must come before `GENERATED_MODULES` so the `DRIZZLE`
provider exists when generated modules instantiate.

`GENERATED_MODULES` starts with `DbConstraintErrorsModule`
(`runtime/nest-db-constraint-filter.ts`): one global exception filter that answers a write the database refused on
a constraint with a 4xx instead of a 500 — a foreign key that names no row is **422** `foreign_key_violation`, a
taken unique value **409** `unique_violation`, a delete of a row another still references **409**
`still_referenced`. The body is the generated code's error shape, `{ statusCode, error, code, fields, constraint,
message }`, where `fields` names the request's properties (`projectId`). Every other error keeps Nest's own handling.
The classification is framework-free (`runtime/db-constraint-errors.ts`, `constraintViolationOf` +
`constraintViolationBody`), so a non-Nest HTTP layer answers with the same body. `OpenApiModule` is
`@Global()` so every generated module's `@Inject(OPENAPI_REGISTRY)`
resolves without the feature module having to import anything extra —
NestJS's DI doesn't propagate providers from a parent into imported
feature modules by default, so a plain AppModule-level provider wouldn't
reach `AccountsModule` / `ContactsModule` / etc. The registry is the
singleton consumed by every generated entity module (OPENAPI-2) and read
by `main.ts` at boot to build the Swagger document (OPENAPI-4) — never
instantiate `new OpenApiRegistry()` anywhere else. Any non-codegen modules you author (`AuthModule`,
`HealthModule`) go in the same `imports:` array — the barrel is
additive, not exclusive. See
[ADR-017](./adrs/ADR-017-barrel-files-over-injects.md) for why codegen
writes a barrel instead of mutating this file.

`codegen project init` also drops a default `src/main.ts` that imports
`openapiConfig` from the generated `src/generated/app-config.ts`, awaits
`registry.build(...)`, and calls `SwaggerModule.setup(openapiConfig.path, app, document)`
when `openapiConfig.enabled` is true. The app never parses `codegen.config.yaml`:
the generator validates the `openapi:` block and writes it into that module
(see `codegen.config.yaml` below). If your project already owns `main.ts` (custom
logging, Helmet, CORS, etc.), run `codegen project upgrade-openapi`, or copy this
block into your own bootstrap:

```ts
// src/main.ts (excerpt — paste into your existing bootstrap)
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { OPENAPI_REGISTRY, OpenApiRegistry } from '@pattern-stack/codegen/runtime/shared/openapi'; // vendored: './shared/openapi'
import { openapiConfig } from './generated/app-config';

// inside async function bootstrap(), after `await NestFactory.create(AppModule)`:
if (openapiConfig.enabled) {
  const registry = app.get<OpenApiRegistry>(OPENAPI_REGISTRY);
  const registryDocument = await registry.build({
    title: openapiConfig.title,
    version: openapiConfig.version,
    description: openapiConfig.description,
  });
  const docBuilder = new DocumentBuilder()
    .setTitle(openapiConfig.title)
    .setVersion(openapiConfig.version);
  if (openapiConfig.description) docBuilder.setDescription(openapiConfig.description);
  if (openapiConfig.auth === 'bearer') docBuilder.addBearerAuth();
  const document = SwaggerModule.createDocument(app, docBuilder.build());
  document.components = {
    ...document.components,
    schemas: { ...(document.components?.schemas ?? {}), ...registryDocument.components.schemas },
  };
  SwaggerModule.setup(openapiConfig.path, app, document);
}
```

## Application logger

`@pattern-stack/codegen/runtime/shared/logging` ships a compact console logger
plus a `LOG_LEVEL` threshold knob. It replaces Nest's default
`ConsoleLogger`, whose preamble — `[Nest] <pid>  - <full locale date>   LEVEL
[Context]` (~55 chars) — wraps 2–3× in split-pane dev TUIs (process-compose,
tmux), and gives consumers a log-level dial they otherwise lack (the generated
entrypoints pass no `logger:`, so every subsystem `debug` line — e.g.
EventScheduler's per-slot `materialised …` — always prints).

`CompactConsoleLogger` drops the `[Nest] <pid>  - ` prefix (a supervisor pane
header already names the process) and shortens the timestamp to `HH:mm:ss`:

```
12:48:42   LOG [EventScheduler] materialised 2 slot(s)
```

Hand it to `NestFactory` in your entrypoint:

```ts
// src/main.ts
import { createAppLogger } from '@pattern-stack/codegen/runtime/shared/logging';

const app = await NestFactory.create(AppModule, { logger: createAppLogger() });
```

```ts
// src/worker.ts (standalone worker)
const app = await NestFactory.createApplicationContext(WorkerAppModule, {
  logger: createAppLogger(),
});
```

### `LOG_LEVEL` threshold

A single severity threshold enables that level and everything above it
(`verbose < debug < log < warn < error < fatal`); the default is `log`.

| `LOG_LEVEL` | Enabled levels |
|---|---|
| _(unset)_ / `log` | `log`, `warn`, `error`, `fatal` |
| `debug` | `debug` and above |
| `verbose` | everything |
| `warn` | `warn`, `error`, `fatal` |

Unknown values warn once and fall back to `log`. `createAppLogger(threshold?)`
takes an explicit override that wins over the env var — CLI tools pass `'warn'`
to stay quiet regardless of the ambient `LOG_LEVEL`:

```ts
const logger = createAppLogger('warn'); // ignores LOG_LEVEL
```

> The generated entrypoints don't yet wire this automatically — pass
> `createAppLogger()` yourself in `main.ts` / `worker.ts` (a future codegen
> release will scaffold it into the worker template).

## `codegen.config.yaml`

What `project init` writes (backend only), plus the `semantic` switch:

```yaml
# yaml-language-server: $schema=./node_modules/@pattern-stack/codegen/src/schema/codegen-config.schema.json
runtime: package                    # import the runtime from the package (ADR-037); `vendored` copies it into src/shared/

target:                             # the data layer generated code is written for (ADR-047)
  database: postgres
  orm: drizzle

paths:
  backend_src: src                  # backend writes to <backend_src>/modules/<plural>/
  entities: entities
  events_dir: events                # top-level events/*.yaml source for event codegen
  generated: src/generated          # ADR-017 barrels land here

generate:
  frontend: false                   # emit Electric-SQL frontend pipeline?
  semantic: false                   # emit the semantic model? (needs @pattern-stack/query-surface, below)

```

### `generate.semantic: true` — install `@pattern-stack/query-surface`

The emitted `<paths.generated>/semantic/` imports from `@pattern-stack/query-surface`, the semantic-query package that
runs it. It is an **optional peer** of `@pattern-stack/codegen` (`^0.3.1`): install it yourself when you turn
`generate.semantic` on, or the generated tree fails to compile with `Cannot find module
'@pattern-stack/query-surface'`.

```bash
bun add @pattern-stack/query-surface@^0.3.1
# npm: the flag is required next to codegen's Nest 10 peers (see below)
npm install --legacy-peer-deps @pattern-stack/query-surface@^0.3.1
```

- **npm needs `--legacy-peer-deps`.** The package declares optional peers on `@nestjs/common` / `@nestjs/swagger`
  `^11` for its `./nest` adapter; codegen's are `^10`. npm treats an installed optional peer outside its range as a
  conflict and stops with `ERESOLVE`. The generated model imports only the package root, which loads neither Nest nor
  any other optional peer, so the mismatch does not reach it. It does stop a Nest 10 app from mounting the package's
  `./nest` adapter.
- **Licence:** FSL-1.1-MIT (converts to MIT two years after each release). Check it fits your use before you ship.

**The file is validated strictly.** Every `codegen` command (and every generator it runs) parses
`codegen.config.yaml` through one schema, `CodegenConfigSchema` (`src/schema/codegen-config.schema.ts`). An unknown
or removed key — a typo such as `paths.entitis`, or `paths.entities_dir`, which was replaced by `paths.entities` — is
an error that names the key, lists the keys expected there, and exits 1. There is no warning mode. The top-level
blocks are:

| Block | What it configures |
|---|---|
| `runtime` | `package` (default) \| `vendored` — where generated code imports the runtime from (ADR-037) |
| `target` | `{ database, orm }` — the data layer the generated tables, columns and repositories are written for. Supported pairs: `{ database: postgres, orm: drizzle }` (the default), `{ database: sqlite, orm: drizzle }` (TGT-2b: the storage layer — `sqliteTable` modules and `<entity>.sql`; the Nest layers come with `wiring: pattern-stack`). An unsupported pair is an error naming the supported ones; when written, both keys are required. `wiring` and `http` take the supported apps: `{ wiring: nest, http: nest }` (the default) and `{ wiring: pattern-stack, http: none }` (no NestJS: see A project without NestJS). `runtime` joins when it has a second value, so any other key under `target:` is an error. The driver follows from the database (and, later, the runtime) and has no key (ADR-047) |
| `paths` | `backend_src`, `frontend_src`, `entities`, `events_dir`, `jobs_dir`, `providers`, `modules_dir`, `orchestration_src`, `generated` |
| `generate` | `frontend`, `semantic` |
| `tables` | `prefix` — prepended to the SQL table name of every entity and junction that does not set `table:` (the literal name, used verbatim) or its own `table_prefix:` (`''` opts out); default `''`. Only SQL-facing names follow it — `pgTable('…')`, index / constraint names, Electric shapes, the semantic model's `tableName`, `foreign_key:` targets. The Drizzle export, `db.query` key, module folder and classes stay on `plural` (`src/config/table-naming.ts`) |
| `tenancy` | `column` — the column `tenant_scoped` entities scope on; snake_case, default `tenant_id`. An entity's `tenant_scoped: { column }` overrides it, and a column the entity already declares (a field, or a `belongs_to` foreign key) is adopted rather than emitted twice (`src/schema/tenancy.ts`) |
| `patterns` | glob list for app-defined patterns (below); default `<backend_src>/patterns/*.pattern.ts` |
| `locations` | `path` / `import` overrides for the frontend emitter's three named locations (`dbEntities`, `frontendGenerated`, `frontendCollectionsAuth`) |
| `frontend` | the frontend emitter (README › Frontend generation) |
| `dev` | `port` for `codegen dev` |
| `auth` | `devAllowAnonymous` (ADR-043), `redirect_uri_base` (auth subsystem) |
| `subsystems` | `install:` — the installed-subsystem list in package mode |
| `events`, `jobs`, `bridge`, `integration`, `observability`, `openapi`, `cache`, `storage` | written by `codegen subsystem install <name>`; see each subsystem's section |

**Editor completion.** The package ships the same schema as JSON Schema,
`src/schema/codegen-config.schema.json`, generated from `CodegenConfigObjectSchema` (the file as written, before
the defaults that depend on another block are filled), so it cannot drift from the parse. Point the
YAML language server (VS Code's Red Hat YAML extension, JetBrains, Zed, Neovim's `yamlls`) at it, and the editor
completes every block and key, shows its description, offers only the supported `target:` pairs and underlines
anything else. `project init` writes this first line into `codegen.config.yaml`; add it to a config you wrote yourself:

```yaml
# yaml-language-server: $schema=./node_modules/@pattern-stack/codegen/src/schema/codegen-config.schema.json
```

or map it once in `.vscode/settings.json`:

```json
{
  "yaml.schemas": {
    "./node_modules/@pattern-stack/codegen/src/schema/codegen-config.schema.json": "codegen.config.yaml"
  }
}
```

The schema checks each key on its own. Rules that span keys (the jobs pool rules, `jobs.backend: memory` with a
standalone worker) are checked by `codegen` when it parses the file, so the generator stays the gate.

Two maps are open by design: `jobs.pools` (keyed by pool name; each pool's keys are still checked, and so are the
pool rules — a framework pool may set only `concurrency` / `description`; your own pool needs `queue` +
`concurrency`) and `frontend.parsers` (keyed by column type).

**Your app never reads this file.** The values it needs at boot — `openapi.*`, `auth.devAllowAnonymous`,
`jobs.pools`, and the standalone worker's `jobs.backend` / `jobs.extensions.*` — are written by the generator into
`<paths.generated>/app-config.ts` (`openapiConfig`, `authConfig`, `jobPools`, `jobWorkerOptions`), which `main.ts`,
`<generated>/subsystems.ts` and `worker.ts` import. `worker.ts` is emit-once and holds no config value:
`JobWorkerModule.forRoot(jobWorkerOptions)`. A `worker.ts` emitted before 0.31.0 bakes its options inline — replace
them once with that call and `import { jobWorkerOptions } from './generated/app-config'` (`subsystem install jobs`
prints the edit). Like every other generated file it
is rewritten on regeneration (`codegen entity new --all`, any `codegen subsystem install`, `project upgrade-openapi` /
`upgrade-auth`); editing `codegen.config.yaml` changes nothing until you regenerate, and a bad value fails the
regeneration with the key named — never a silently-defaulted boot. `codegen subsystem install` regenerates from the
config block it has just written, so a fresh install's `subsystems.ts` / `app-config.ts` already reflect it. A
generated file the app imports that cannot be written — the barrels and `app-config.ts`, and everything else
`entity new` emits after the entity modules (the `ScopeEntityType` union, the event modules, the bridge registry,
orchestration modules, the frontend tree, provider / adapter / integration-assembly / job-handler files) — fails the
command with exit 1 and the file named (or the step's output directory, when it failed before writing: an invalid
`events/*.yaml`, a duplicate `@JobHandler` trigger) — never a warning over a stale module. Three inputs every entity's
output depends on stop `entity new` before it generates anything, whatever `--continue-on-error` says: an invalid
`<paths.jobs_dir>/*.yaml` (its handler, scheduled events and bridge triggers feed registries every module imports), an
app-pattern file the `patterns:` globs match but that cannot be loaded (the orchestration barrel would be rewritten
without its module), and a `<paths.providers>/*.yaml` that does not load or fails the provider cross-check — unknown
surface, duplicate slug, an auth strategy / client import that does not resolve (its module and assemblies feed every
integrated entity's wiring). Each is listed like a rejected entity YAML — file, reason, details; in `--json`, under `failed[]`
with `stopped: 'pre-flight'` — and the command exits 1. A `<type>.job.generated.ts` emitted from a job YAML that no
longer loads is left on disk and named as stale in the rejection. A job YAML that loads but whose project has not
installed the integration subsystem stops the run the same way: every arm's `read:` block is a `DetectionConfig`, which
the job's handler base types against the integration subsystem, so the rejection names the job, the arm and `codegen
subsystem install integration` (#745). "Installed" is what the subsystem barrel composes from — the vendored
`integration.module.ts` under `runtime: vendored`, `subsystems.install` under `runtime: package`. The app has no `yaml`
dependency.

The backend layout is backend — a module folder per entity under `paths.modules_dir` — and there is no other. The `clean` pipeline and its `generate.architecture` key were deleted (ARCH-0, #677): a config that still sets the key fails with `generate.architecture: unknown key`, naming the file. Delete the line.

ARCH-1 (#682) deleted the rest of the surface only `clean` read, so these fail the same way — delete them too:
`naming:` (file-case / suffix-style / terminology: backend file names are fixed), `database:` (`dialect`),
`behaviors:` (`strategy`), the 14 `locations.backend*` names plus `locations.dbSchemaServer` / `dbSchemaClient` /
`dbMigrations` / `dbContextEngine`, and, in **entity YAML**, `folder_structure:`, `file_grouping:` and
`behavior_strategy:`. `expose:` is unaffected — the frontend emitter reads it.

**`paths.*` defaults.** Each key has exactly one default, declared in `PathsConfigSchema`; every command, generator and
scaffold reads the same resolved value (PATH-0). Three keys default relative to `backend_src`:

| Key | Default |
|---|---|
| `backend_src` | `src` |
| `frontend_src` | `apps/frontend/src` |
| `entities` | `entities` (no second candidate: a configured directory that does not exist is not replaced by `entities/`) |
| `events_dir` | `events` |
| `jobs_dir` | `definitions/jobs` |
| `providers` | `definitions/providers` |
| `generated` | `<backend_src>/generated` |
| `modules_dir` | `<backend_src>/modules` — the backend module tree (every entity, relationship and junction module, the barrels' and integration assemblies' imports, the `@modules/*` alias) and the `auth-integrations` vendor root |
| `orchestration_src` | `<backend_src>/orchestration` |

`project init` and every `subsystem install` honour them. In a monorepo, write `codegen.config.yaml` with e.g.
`paths.backend_src: apps/backend/src` **before** `codegen project init`: init then writes `app.module.ts`, `main.ts`,
`schema.ts`, `shared/**` and the barrels there, `README.md` (how to add an entity — not YAML, so no loader reads it) into `paths.entities`, and tsconfig aliases
(`@shared/*`, `@modules/*`, `@generated/*`) and `include` pointing at them. The imports in the emitted files are computed
relative to each file.

There is no `paths.subsystems`: the subsystem runtime lives at `<backend_src>/shared/subsystems`, the only place the
`@shared/subsystems/<name>` imports reach (PATH-1). Setting it is an unknown-key error.

`paths.generated` and `paths.modules_dir` must sit inside your `tsconfig.json` `"include"` globs — otherwise TS won't
typecheck them. (`project init --with-tsconfig` adds each one that lies outside `backend_src`.)

## App-defined patterns

`pattern:` in entity YAML selects a base-class bundle (repository + service + implied columns + implied behaviors + per-entity config schema) that the generated concrete class extends. See [ADR-031](./adrs/ADR-031-app-defined-patterns.md) for the binding decisions.

### Library-shipped patterns

The codegen package pre-registers five patterns. Consumers never list these in `codegen.config.yaml`:

| Pattern | Repository class | Notes |
|---------|-----------------|-------|
| `Base` | `BaseRepository` | Identity pattern — base CRUD only |
| `Integrated` | `IntegratedEntityRepository` | Adds `external_id` / `provider` / `provider_metadata` + integrationUpsert |
| `Activity` | `ActivityEntityRepository` | Time-bounded interaction entities (notes, calls, meetings) |
| `Knowledge` | `KnowledgeEntityRepository` | Long-form content with workflow status + semantic search |
| `Metadata` | `MetadataEntityRepository` | History-tracked auxiliary rows |

Declare one in entity YAML:

```yaml
entity:
  name: opportunity
  pattern: Integrated
behaviors:
  - timestamps
  - soft_delete
```

### App-defined patterns

Consumers who need a domain abstraction beyond the library set (e.g. a `CrmEntity` bundling EAV routing + canonical field mapping) write their own `*.pattern.ts` file:

```ts
// src/patterns/crm-entity.pattern.ts
import { definePattern } from '@pattern-stack/codegen';
import { z } from 'zod';

export const CrmEntityPattern = definePattern({
  name: 'CrmEntity',
  extends: ['Integrated'],
  repositoryClass: 'CrmEntityRepository',
  serviceClass: 'CrmEntityService',
  repositoryImport: '@/patterns/crm-entity.pattern',
  serviceImport: '@/patterns/crm-entity.pattern',
  configSchema: z.object({ entityType: z.string() }),
  description: 'CRM entity with EAV dual-write + canonical field routing',
});
```

Discovery is via globs in `codegen.config.yaml`:

```yaml
# codegen.config.yaml
patterns:
  - src/patterns/*.pattern.ts          # the default when `patterns:` is absent: <backend_src>/patterns/*.pattern.ts
  - vendor/internal-patterns/*.pattern.ts
```

Use it in entity YAML:

```yaml
entity:
  name: opportunity
  pattern: CrmEntity
  config:
    CrmEntity:
      entityType: opportunity
```

The generated concrete class emits `protected override readonly patternConfig = { entityType: 'opportunity' } as const;` for the pattern's base class to read. No reflection; identical shape to `behaviors: BehaviorConfig`.

### tsconfig alias requirement

App-defined patterns reference their hand-written base classes via path aliases (`@/patterns/crm-entity.pattern`). Codegen emits the string verbatim into the generated `import` — resolution is the consumer's `tsconfig.json` responsibility. Add your alias alongside the others:

```jsonc
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["./shared/*"],
      "@modules/*": ["./modules/*"],
      "@/*": ["./src/*"]
    }
  }
}
```

If the alias is missing, TypeScript compile of the generated code fails at import resolution — the codegen step itself does not verify the path resolves on the consumer side.

### Composition (multi-pattern)

Two or more patterns combine via `patterns:`:

```yaml
entity:
  name: deal
  patterns: [CrmEntity, Event]
  config:
    CrmEntity: { entityType: opportunity }
    Event:
      states:
        qualifying: [developing, closed_lost]
      initial_state: qualifying
```

The **first** pattern in the list wins the base-class selection. Subsequent patterns contribute columns + implied behaviors. Column-name conflicts, unknown pattern names, and invalid `config:` blocks are caught at codegen time with a hard error; `config:` keys for undeclared patterns produce warnings.

### Caveats (Phase 1)

- **Single-depth `extends` chain only.** A pattern may `extends: ['Integrated']` but transitive resolution of `CrmEntity extends Integrated extends Base` is deferred.
- **Method-name conflicts are caught by TypeScript**, not codegen. Two patterns declaring methods with the same signature surface as a compile error at the consumer class, not a codegen validation error.

## EAV dual-write — opt-in per entity

Two YAML flags light up the EAV (entity-attribute-value) surface. Both default to `false` — entities that don't declare them get the non-EAV shape unchanged.

### `eav: true` on owning entities

Declare this on the entity that has a dynamic `fields` bag alongside its core columns (e.g. `opportunity`, `account`, `contact`).

```yaml
# entities/opportunity.yaml
entity:
  name: opportunity
  pattern: Integrated
eav: true
fields:
  name:
    type: string
    required: true
  user_id:            # required: each custom-field value is stamped with its owner
    type: uuid
    required: true
  # ... core columns
```

With writes, `user_id` must be required on create (the value table needs the column); `entity new` refuses an entity
without it, by name.

Codegen emits:

- `Create<Entity>UseCase` / `Update<Entity>UseCase` in transactional compound-write shape — splits `{ fields, ...core }` from the DTO and runs both halves in `db.transaction(async (tx) => ...)`.
- `Find<Entity>ByIdWithFieldsUseCase` / `List<Entity>sWithFieldsUseCase` — paired reads that merge the EAV `fields` bag onto the entity.
- `GET /<entity>/:id/with-fields` + `GET /<entity>/with-fields` routes on the controller.
- `findByIdWithFields` + `listWithFields` methods on the service.
- Module imports of the paired value-table module so DI resolves.

### `eav_value_table: true` on the value-table entity

Declare this on the entity that IS the value table (e.g. `field_value`). Paired with `eav_definition_table: <singular-entity-name>` pointing at the field-definitions entity.

```yaml
# entities/field_value.yaml
entity:
  name: field_value
  pattern: Metadata
eav_value_table: true
eav_definition_table: field_definition
fields:
  entity_type:
    type: string
    required: true
  entity_id:
    type: uuid
    required: true
  field_definition_id:
    type: uuid
    required: true
  user_id:
    type: uuid
    required: true
  value:
    type: json
    required: true
```

Codegen emits:

- `upsertCurrentValues(rows, tx?)` on the repository — composite `(entity_type, entity_id, field_definition_id)` conflict target, so repeated upserts update a row in place rather than appending.
- `upsertFieldsTransactional(entityType, entityId, userId, fields, tx?)` on the service — resolves field keys to definition ids internally (via the injected definition repo) and delegates to the repo's upsert.
- `findMergedByEntity(entityType, entityId)` on the service — reads value rows + definitions in parallel, collapses via `mergeEavRows` into a flat `{ key: value }` bag.
- Auto-imports the paired field-definitions module so DI resolves.

**v1 assumption:** `eav_value_table: true` expects a NOT-NULL `user_id` column on the value table. A future `eav_user_scoped: false` flag will relax this for audit/system EAV with no user context.

### What the consumer has to author for EAV

Nothing beyond the YAML flags. Every consumer contract item — tx-aware base classes, the EAV helpers, the composite conflict-target upsert — ships via `codegen project init` (the vendored runtime files above) or via the generated templates.

The one thing consumers do own: creating `field_definition` rows before they reference them. `upsertFieldsTransactional` silently skips keys with no definition; auto-create is a later step.

## Verification

After authoring the shims, `DatabaseModule`, `schema.ts`, `app.module.ts`, and `codegen.config.yaml`:

```bash
# Regenerate the full entity set
bun /path/to/codegen-patterns/src/cli/index.ts entity new --all
# (or `just gen-all` / `npx @pattern-stack/codegen entity new --all` depending on install form)

# Typecheck — zero errors expected
bun run typecheck
# or: bunx tsc --noEmit
```

If typecheck is clean, the contract is satisfied. If there are errors, they'll almost always trace to one of the causes below.

## Troubleshooting

### `Cannot find module '@shared/constants/tokens'` (or any `@shared/*` path)

The `@shared/*` alias is missing from `tsconfig.json` `compilerOptions.paths`, or the shim file at the aliased location doesn't exist. Re-check the [shims list](#shared-re-export-shims) and the [path aliases block](#tsconfig-path-aliases).

### `Nest can't resolve dependencies of the <X>Repository (?)`

The `DRIZZLE` token isn't being provided. Either `DatabaseModule` isn't imported in `AppModule`, isn't `@Global()`, or you've declared a second `DRIZZLE` constant locally that shadows the runtime one. The token must be re-exported from `@shared/constants/tokens` (see above), not redefined.

### `AUTO-GENERATED` barrels never appear in `src/generated/`

You're likely using the legacy CLI (`bun src/cli.ts entity entities/foo.yaml`), which doesn't regenerate barrels. Use the noun-verb CLI: `codegen entity new --all` (or `src/cli/index.ts entity new --all`). See `DOGFOOD-LOG.md` entry about "Barrels are only regenerated by the noun-verb CLI".

### `Cannot find module 'config/paths.mjs'` when invoking the CLI

Stale import in `templates/entity/new/prompt.js`; fixed upstream. Update your `codegen-patterns` checkout to a recent commit.

### `Error: I can't find action 'new' for generator 'entity'`

The CLI can't locate its templates dir. Default path resolves relative to the CLI's own file — if you're invoking from outside the `codegen-patterns` repo, set:

```bash
export CODEGEN_TEMPLATES_DIR=/path/to/codegen-patterns/templates
```

### Type errors referencing private Drizzle internals, or `Property 'table' … is not assignable`

Two incompatible `drizzle-orm` copies in the resolved module graph. The runtime base classes must typecheck against the same `drizzle-orm` your generated entities do — `drizzle-orm` is a **peer dependency** of `@pattern-stack/codegen` precisely so that there is only one. Fix the resolution, in this order:

1. Make sure your project declares `drizzle-orm` on the 1.0 line (`^1.0.0-rc.4`) and that nothing else in the tree pins an older major. `bun pm ls drizzle-orm` / `npm ls drizzle-orm` should show exactly one version.
2. In a monorepo, dedupe it at the workspace root rather than per package.
3. **If you `bun link` / `npm link` the generator**, its own dev copy of `drizzle-orm` is still on disk next to it, and a linked package resolves its own `node_modules` first — so you get two copies even with a correct declaration. Either install the generator from a tarball (`npm pack` → `bun add ./pattern-stack-codegen-*.tgz`, which is what `just test-post-publish` exercises), or force resolution with a tsconfig `paths` entry mapping `drizzle-orm` (and `drizzle-orm/*`) at your own copy. `preserveSymlinks` also works, with the usual caveats.

### `Types have separate declarations of a private property 'shouldInlineParams'`

You have two copies of drizzle-orm installed — one in your project and one in codegen-patterns. This happens when `shared/base-classes/*.ts` re-exports from `../../codegen-patterns/runtime/` via relative paths instead of containing vendored copies.

Fix: copy the runtime files into your project rather than re-exporting. Use `codegen project init --runtime vendored` to set up vendored copies, or copy `runtime/base-classes/` into `shared/base-classes/` manually. Each file should contain the actual code, not a `export * from '../../../codegen-patterns/runtime/...'` re-export.

### HTML-escaped entities in generated TypeScript (`&#39;` instead of `'`)

EJS template escape bug, fixed upstream. Pull the latest `codegen-patterns` and regenerate.

### Generator emits files outside `paths.generated`

It shouldn't — that's a bug. File an issue. The only files codegen writes are (a) per-entity module trees under `paths.modules_dir` and (b) the two barrels under `paths.generated`. If `app.module.ts` or a hand-authored file changed, something is wrong.

## References

- [ADR-017 — Barrel Files over Hygen Injects](./adrs/ADR-017-barrel-files-over-injects.md) — why `@shared/*` exists and why codegen never mutates your files
- [ADR-015 — CLI Command Architecture](./adrs/ADR-015-cli-command-architecture.md) — install forms and the noun-verb interface
- [ADR-031 — App-Defined Patterns](./adrs/ADR-031-app-defined-patterns.md) — `pattern:` / `patterns:` / `config:` surface; supersedes the legacy ADR-005 `family:` enum
- [consumer/drizzle.md](./consumer/drizzle.md) — the Drizzle 1.0 peer range, the `drizzle({ client })` constructor, and drizzle-kit's 1.0 migration-folder layout
- [GETTING-STARTED.md](./GETTING-STARTED.md) — entity YAML authoring and the generator lifecycle
