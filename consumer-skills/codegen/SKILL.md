---
name: codegen
description: >-
  Load when working in a project that uses @pattern-stack/codegen to scaffold a
  NestJS + Drizzle backend from YAML — i.e. when the request is to add or change
  an entity / module / CRUD resource, generate code from `entities/*.yaml`, run
  the `codegen` (aka `cdp`) CLI, install or wire an infrastructure subsystem, or
  refresh the project after a package upgrade. This is the entry-point router;
  it points at the focused `entities`, `subsystems`, `jobs`, `events`, `bridge`,
  and `integration` skills for deep work.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Using @pattern-stack/codegen in this project

This project generates its backend (domain entities, repositories, services,
controllers, DTOs, use cases, Drizzle schemas, NestJS modules) from YAML entity
definitions — one NestJS module folder per entity. You author small YAML files and run
the `codegen` CLI; the generator owns a few directories and never touches the
rest of your app.

The CLI binary is `codegen` (alias `cdp`). Every noun supports `--json` for
machine-readable output and `--cwd <path>` to target another project root.

## Mental model

- **You own**: `entities/*.yaml`, `events/*.yaml`, `app.module.ts`, `main.ts`,
  `database.module.ts`, `codegen.config.yaml`, and your hand-written use cases /
  adapters.
- **Codegen owns** (don't hand-edit — regenerated every run):
  - `src/generated/modules.ts` — the `GENERATED_MODULES` barrel
  - `src/generated/schema.ts` — the Drizzle schema barrel
  - `src/generated/app-config.ts` — the config values your app reads at boot
  - the per-entity module tree (`src/modules/<plural>/…`)

  If one of the generated barrels (including `subsystems.ts` /
  `subsystems-schema.ts`) cannot be written, the command exits 1 and names the
  file — fix that (a permission, a directory in the way) and re-run. Files
  that run already wrote (the entity module tree) stay; re-running converges.
- **Where the runtime comes from** depends on `runtime:` in
  `codegen.config.yaml` (ADR-037):
  - `package` (the default) — generated code imports the runtime straight from
    `@pattern-stack/codegen/subsystems` and `@pattern-stack/codegen/runtime/*`.
    Nothing is vendored.
  - `vendored` — the package copies its runtime (base classes, types, the
    `DRIZZLE` token, the Zod pipe, the OpenAPI registry) into `src/shared/**`
    and installed subsystems into `<subsystems-root>/<name>/`, imported via
    `@shared/*`. Treat those copies as generated output: don't hand-edit;
    subclass instead. `codegen update` refreshes them after a package bump.

  Check which mode this project uses before writing an import. Don't flip
  modes by accident.

The generation pipeline: `YAML → parse → analyze → templates → code`. After any
generation run the two barrels are rewritten and you wire them into
`app.module.ts` exactly once — codegen never edits that file again. Installed
subsystems get their own pair: `src/generated/subsystems.ts`
(`SUBSYSTEM_MODULES`) and `src/generated/subsystems-schema.ts`. Wire each of
those once as well.

## Authentication (ADR-043, 0.30.0+)

The generated data plane is **closed by default**:

- `AuthModule.forRoot` binds `AuthenticatedGuard` globally. Any route not
  marked `@Public()` returns 401 when the request has no authenticated
  requester.
- `main.ts` calls `installRequesterContext(app)` and **refuses to start** when
  no `IUserContext` is bound under `AUTH_USER_CONTEXT`.
  `auth.devAllowAnonymous: true` in `codegen.config.yaml` bypasses this — after
  you regenerate (see below). It is for localhost only; never ship it.
- Generated controllers do **not** read `x-user-id` / `x-tenant-id` headers.
  Use cases get the actor from the request context (`tryGetRequester()`).
  Don't add header-sourced identity back.
- To keep an entity internal (no REST/Electric/tRPC routes) while still
  generating its service and use cases, set `api: false` at the top level of
  its YAML.

**Upgrading from before 0.30.0:** after bumping the package, run
`codegen project update`, then `codegen project upgrade-auth`. The latter is
idempotent: it wires `AuthModule` plus the boot check into `app.module.ts`
and `main.ts`. Then bind your own `IUserContext`, backed by your session or
JWT scheme.

## Routing — load the focused skill for deep work

| Task | Read |
|---|---|
| Author / change an entity YAML (fields, families, queries, EAV, relationships) | the `entities` skill |
| Install or wire an infrastructure subsystem; get the `forRoot` registration order right | the `subsystems` skill |
| Write a background `@JobHandler`, configure pools, set concurrency/ordering | the `jobs` skill |
| Author a domain event, publish via the outbox, use the typed event bus | the `events` skill |
| React to an event with a durable async job (the event-to-job bridge) | the `bridge` skill |
| Pull/push data from an external system (`IChangeSource` / `IIntegrationSink`) | the `integration` skill |

## Frontend generation (`generate.frontend: true`)

When on, `entity new` (and `--all`) ends with a **whole-set frontend emitter**
(ADR-038): the complete data layer is rendered into
`locations.frontendGenerated` (default `apps/frontend/src/generated/`) from the
full entity set — REST api client, TanStack DB collections (per-entity
`sync: api | electric`), `createEntityHooks` wiring, field metadata, a
plural-keyed `createStore`, `config.ts`, `query-client.ts`, root barrel. Every
file is a complete write with a `@generated` banner; re-runs are byte-identical.

Non-obvious bits:

- **The dbEntities contract**: generated files import the plain `<Class>` type
  AND a `<camel>Schema` Zod schema from `locations.dbEntities` per entity. If
  the backend doesn't emit such a package (clean-lite-ps doesn't), the consumer
  provides a shim barrel re-exporting each module's Output DTO.
- **The consumer mounts two providers** in the app root, both from generated
  code: `QueryClientProvider(queryClient)` ▸ `EntityStoreProvider(store)`
  (`EntityStoreProvider` from `@pattern-stack/frontend-patterns`).
- **Version pairing**: the emitted imports require
  `@pattern-stack/frontend-patterns` + four TanStack packages — the exact
  ranges are listed in the generated `index.ts` header comment.
- **Path aliases are assumed**: default imports use `@/…` (and your
  `locations.*.import` values) — wire tsconfig `paths` + the bundler alias.
- **Providers catalog**: when `definitions/providers/` exists, the emitter also
  renders `providers.ts` — `PROVIDERS` (flat) + `PROVIDER_CATALOG` (grouped by
  each provider's `display.category` into `frontend.catalog.categories`).
  Providers are gen-time knowledge: the catalog is emitted, never queried, and
  never hand-duplicated in the frontend. `status: planned` provider YAMLs are
  roadmap stubs — catalog tile only, no auth/client needed, skipped by all
  backend emission.

## CLI quick reference

```bash
# Project lifecycle
codegen init                       # scaffold this project's shared layer + config + skills
codegen project scan               # detect framework/ORM/architecture → propose config
codegen project config             # print the resolved codegen.config.yaml
codegen update                     # re-sync vendored runtime + subsystems + skills after a package bump
codegen project upgrade-auth       # wire the ADR-043 auth guard + boot check (idempotent)

# Entities
codegen entity new entities/<file>.yaml   # generate one entity
codegen entity new --all                  # regenerate every entity in entities/
codegen entity new --all --dry-run        # preview
codegen entity list                       # tabular list
codegen entity validate --strict          # validate YAML + cross-refs (warnings fail)
codegen relationship new --all            # relationships/*.yaml — junction tables
codegen junction new --all                # junctions/*.yaml — first-class M:N with role/temporal metadata

# Subsystems (see the `subsystems` skill for wiring + order)
codegen subsystem                  # summary: installed vs available
codegen subsystem install <name>   # vendor a subsystem's runtime + inject its config block
codegen subsystem list
codegen subsystem remove <name>

# Skills
codegen skills install             # (re)vendor these consumer skills into .claude/skills
codegen skills list
```

## Non-obvious rules

- **`codegen.config.yaml` is validated strictly.** An unknown or removed key (a
  typo, or `paths.entities_dir` — use `paths.entities`) stops every `codegen`
  command with an error naming the key and the keys expected there. Fix the
  key; there is no flag to skip validation. Block reference: `docs/CONSUMER-SETUP.md`
  › `codegen.config.yaml`.
- **Your app never reads `codegen.config.yaml`.** The keys it needs at boot —
  `openapi.*`, `auth.devAllowAnonymous`, `jobs.pools`, the worker's
  `jobs.backend` / `jobs.extensions.*` — are validated and written into
  `src/generated/app-config.ts` (`openapiConfig`, `authConfig`, `jobPools`,
  `jobWorkerOptions`), which `main.ts`, the subsystem barrel and `worker.ts`
  import. `worker.ts` holds no config value — never edit options into it.
  After editing one, regenerate (`codegen entity new --all` or any
  `codegen subsystem install`); a bad value fails there, naming the key.
- **`entity new` refuses to generate from a broken shared input.** A job
  YAML (`definitions/jobs/`), an app-pattern file your `patterns:` globs match
  or a provider YAML (`definitions/providers/`) that does not load or validate
  stops the whole run before anything is written — exit 1, the file and reason
  printed (`--json`: `failed[]`, `stopped: 'pre-flight'`) — whatever
  `--continue-on-error` says: every entity's output depends on them. A bad
  entity YAML only skips that entity (exit 1 at the end). Fix the file and
  re-run. `orchestration gen` stops the same way on a pattern file it cannot
  load; `entity validate` and `project inspect --kind analyze` report it as
  an error and exit 1.
- **YAML is `snake_case`; generated TS properties are `camelCase`.** The
  templates derive `accountId` from `account_id`. Entity names are singular
  `snake_case` (`opportunity`).
- **One backend layout.** Every entity is a module folder under
  `paths.modules_dir` (`src/modules/[<context>/]<plural>/`). There is no
  `generate.architecture` key; a config that sets it is rejected.
- **Barrels are wired once.** After the first `entity new`, add
  `...GENERATED_MODULES` to `app.module.ts` and `export * from
  './generated/schema'` to your schema root. Codegen keeps the barrel contents
  fresh; you never re-touch `app.module.ts` for new entities.
- **Migrations are not `drizzle-kit push` in shared/CI/prod.** Generate
  reviewable SQL with Atlas (`atlas migrate diff` → review → `atlas migrate
  apply`). `push` is dev-loop-only.
- **Upgrades need a re-sync.** After `bun add @pattern-stack/codegen@latest`, run
  `codegen update`. Without it, the installed subsystems and skills (and in
  vendored mode, `src/shared/**`) are stale against the new package. Crossing
  0.30.0 also needs `codegen project upgrade-auth` (see Authentication).
- **`unique: true` on a field or query creates an index, not a DB `UNIQUE`
  constraint** (#484, #511). Add the constraint yourself if you rely on it.

## Do not

- **Do not hand-edit anything under `src/generated/`** or the vendored
  `src/shared/**` runtime files — the next `entity new` / `codegen update`
  overwrites them. Need different behavior? Subclass the base in your own module.
- **Do not declare a fresh `DRIZZLE` token.** Import the one the generated
  `database.module.ts` imports: `@pattern-stack/codegen/runtime/constants/tokens`
  in package mode, `@shared/constants/tokens` in vendored mode. A second token has
  a different identity, and DI won't resolve it.
- **Do not add tables directly to `src/generated/schema.ts`.** Hand-authored
  tables go in your own file and are combined in the schema root re-export.
