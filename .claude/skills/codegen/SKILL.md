---
name: codegen
description: Load when working on the @pattern-stack/codegen CLI or its consumer contract — the `codegen` / `cdp` noun-verb commands (entity, relationship, junction, subsystem, project, events, orchestration, skills, dev), entity YAML shape, `codegen.config.yaml` keys, runtime mode (package vs vendored), what `init` / `entity new` / `project update` / `project upgrade-auth` emit into a consumer project, and the generated controller/auth behavior. Routes to the domain skills (jobs, events, bridge, integration, observability, openapi) for subsystem internals.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---

# @pattern-stack/codegen — CLI + consumer contract

Generates a NestJS + Drizzle backend (entities, repositories, services, use cases,
DTOs, controllers, modules, schemas), an optional frontend data layer, the vendor
integration layer, and infrastructure subsystems from YAML definitions.

Binaries: `codegen` and `cdp` (same entry, `dist/src/cli/index.js`). Every noun
accepts `--json` and `--cwd <path>`; most accept `--config <path>`. A bare noun
(`codegen entity`) prints a summary plus suggested next commands.

**Ground truth:** `bun src/cli/index.ts --help` lists every command and flag.
Schemas: `src/schema/entity-definition.schema.ts`, `src/schema/codegen-config.schema.ts`.
If this file disagrees with those, they win — fix this file.

## Routing

| Topic | Load |
|---|---|
| Consumer-facing skills shipped in the package (`consumer-skills/`, vendored by `codegen skills install`) | edit `consumer-skills/<name>/` — the package source (ADR-035) |
| Job handlers, pools, worker, `definitions/jobs/*.yaml` | `jobs` skill |
| Domain events, outbox, `events/*.yaml`, typed bus, scheduler | `events` skill |
| Event → job bridge | `bridge` skill |
| `IChangeSource` / sinks / `surface:` integration codegen | `integration` skill |
| Observability facade | `observability` skill |
| `/docs`, Swagger decorators, `openapi:` config | `openapi` skill |
| ADR / spec / RFC placement | `project-documentation` skill |

## CLI reference

### Entities, relationships, junctions

```bash
codegen entity new <yaml>                 # one entity
codegen entity new --all                  # every YAML under paths.entities (default entities/)
codegen entity new --all --only <names>   # subset
codegen entity new --all --dry-run | --force | --no-continue-on-error
codegen entity list [--pattern <P>] [--format json]
codegen entity validate [dir] [--strict]  # schema + cross-refs; --strict fails on warnings

codegen relationship new <yaml> | --all   # relationships/ — junction tables between entities
codegen relationship list
codegen junction new <yaml> | --all       # junctions/ — first-class M:N with role/temporal/sourcing metadata
codegen junction list
```

`entity new` pre-flights each target (schema, `emits:`, `roles:`) and prints every rejection with its reasons in every
mode; `--json` carries them in `failed[].details`. Continue-on-error is the default: rejected entities are skipped
and the run exits 1. With `--no-continue-on-error` a pre-flight rejection stops the run before anything is generated (#627).
Three pre-flight rejections are **run-level** and stop the run before hygen whatever the flag says: an invalid
`<paths.jobs_dir>/*.yaml` (JOBS-2, #664 — its handler, scheduled events and bridge triggers feed registries every
entity imports), an app-pattern file the loader cannot register (a partial set would rewrite the orchestration barrel
without its module), and a `<paths.providers>/*.yaml` with a blocking issue — it does not load, names an unknown
surface, reuses a slug, or its auth / client import does not resolve (CLI-1, #666 — its module, change sources and
assemblies feed every integrated entity's wiring). Same list, same printing, same `failed[]` entries (`stopped:
'pre-flight'`); a stale `<type>.job.generated.ts` is left on disk and named in the rejection's details. The provider
set is loaded and validated once, in the pre-flight (`loadProviderSet`), and emitted from in the post-step
(`emitProviderModules`); the rejection helpers are `src/cli/shared/run-rejections.ts`. Every other stop before a
target is considered — no entity YAML, `--all` plus a path, neither, a dirty generated-output tree without `--force`
— prints `{ command: 'entity new', status: 'error', error }` under `--json` (#669); the dirty-tree check stops the
JSON run too.

**Cross-entity names come from the target's YAML** (NAME-0). A `belongs_to`, a field `foreign_key: <table>.<col>`, an
`eav_definition_table`, each junction endpoint and each `relationship new` endpoint are addressed by the target entity's own `plural:` (table export +
folder) and `context:` (folder nesting), read from `paths.entities` / `entities/` (the first that exists — the CLI's rule,
`src/config/entities-dir.ts`). A target with no YAML there is a **generation error** naming the directory searched;
for a field `foreign_key:` to a host-owned table (e.g. `tenants.id`, no entity YAML) see #636. A `has_many` onto a target with no YAML — or one not
generated yet — is not wired (the two-pass `targetExists` check), not an error.

**Every generated FK callback is `.references((): AnyPgColumn => <table>.id)`** (NAME-1, #631) — clean-lite-ps
belongs_to + field `foreign_key:`, junction and relationship endpoints. Two tables with FKs to each other (or any
longer FK cycle) therefore compile; the annotation is type-only. A clean-lite-ps service composes each other
entity's repository **once**, however many edges reach it (`clpRepositoryDeps`, #632).

`entity new` also runs the whole-set post-steps, all from the full definition set:

- **Barrels** — `<paths.generated>/modules.ts` (`GENERATED_MODULES`) and `schema.ts`.
  Wired into `app.module.ts` once; codegen never edits that file again.
- **Event registry** — merges `events/*.yaml` (`paths.events_dir`) plus entity
  `events:` / `emits:` into `<subsystems>/events/generated/` (typed bus, schemas, registry).
- **Jobs emitter** — `definitions/jobs/*.yaml` (`paths.jobs_dir`, RFC-0005). Optional; absent dir is fine.
- **Frontend emitter** (`generate.frontend: true`, ADR-038) — `src/emitters/frontend/`.
- **Integration layer** — for entities with `entity.surface` when
  `definitions/providers/*.yaml` exist (RFC-0001/0002/0003). There is no separate
  provider/integration command. Providers with `status: planned` are catalog-only stubs.

### Subsystems

```bash
codegen subsystem                          # installed vs available
codegen subsystem install <name> [--backend <b>] [--target <dir>] [--force] [--force-config] [--dry-run]
codegen subsystem list
codegen subsystem remove <name>
```

Names (`src/cli/shared/subsystem-detect.ts`): `events`, `jobs`, `cache`, `storage`,
`integration`, `bridge` (needs events + jobs), `observability`, `auth`,
`auth-integrations` (vendored OAuth connections starter), `openapi-config`.

Installs register into `<paths.generated>/subsystems.ts` (`SUBSYSTEM_MODULES`) and
`subsystems-schema.ts` — wire each once into AppModule / the drizzle-kit schema
entry. Every subsystem follows Protocol → Backend → Factory (ADR-008) with
`forRoot({ backend })`; scaffolded backends are `drizzle | memory` (`local` for storage).
Registration order: `consumer-skills/subsystems/wiring-and-order.md`.

### Project

```bash
codegen init | project init [--yes] [--dry-run] [--force] [--with-tsconfig] [--runtime package|vendored] [--skills]
codegen project scan [--write]             # detect framework/ORM/architecture → propose config (declared keys only)
codegen project config                     # resolved config (parsed, defaults applied)
codegen update | project update [--dry-run] [--force] [--skip-skills] [--skip-subsystems]
codegen project upgrade-auth [--dry-run] [--path <dir>]      # ADR-043 wiring (see Auth below)
codegen project upgrade-openapi [--dry-run] [--force] [--path <dir>]
codegen project inspect --kind analyze|stats|doc|manifest|suggestions
codegen project graph [--output graph.json]
```

`init` (package mode, the default) writes: `codegen.config.yaml`,
`src/shared/database/database.module.ts`, `src/generated/{modules,schema,app-config}.ts`,
`src/app.module.ts`, `src/main.ts`, `src/schema.ts`, `entities/example.yaml`
(`tsconfig.json` only with `--with-tsconfig`). It picks `clean-lite-ps` unless the
scanner finds real clean-architecture dirs. In `--runtime vendored` it also copies
the runtime closure into `src/shared/**`.

`update` re-syncs vendored runtime, installed subsystems, and consumer skills to the
installed package version. It overwrites divergent package-owned files (git-clean
gate; `--force` overrides) and never touches `codegen.config.yaml`, `app.module.ts`,
or barrels. Subsystem schema shapes that changed need
`subsystem install <name> --force --force-config`.

### Other nouns

```bash
codegen events consumers <eventType>       # consumers across all three tiers (bridge skill)
codegen orchestration list | validate | gen [--pattern <p>] [--all]   # ADR-032
codegen skills install [--force] | list    # vendor consumer-skills/ into .claude/skills
codegen dev up [--no-app] | status | logs [--docker] | restart | down [--volumes]
```

## Runtime mode (ADR-037)

`runtime: package | vendored` in `codegen.config.yaml`. **Default `package`.**

- **package** — generated code imports `@pattern-stack/codegen/subsystems` and
  `@pattern-stack/codegen/runtime/*`; nothing is vendored.
- **vendored** — generated code imports via the consumer's `@shared/*` alias;
  the runtime is copied into `src/shared/**`. Existing vendored projects must set
  `runtime: vendored` explicitly.

Changes to emitted imports must work in both modes. A template never hardcodes a
package-owned `@shared/*` specifier: its prompt resolves it with `runtimeImport(loadRuntimeMode(cwd), '<relpath>')`
from `src/config/runtime-mode.mjs` (entity, junction and relationship prompts all do; #624). Consumer-local files
(`@shared/database/*`, …) stay `@shared/*` in both modes. Gates that compile
both modes: `just test-smoke-capability` (entity + junction + relationship) and `just test-smoke-junction`. The
tarball smoke (`just test-post-publish`) covers package mode from the packed artifact.

## Entity YAML

```yaml
entity:
  name: contact                 # singular snake_case
  plural: contacts
  table: contacts
  pattern: Integrated           # Integrated | Activity | Metadata | Knowledge | Base | app-defined (ADR-031)
  patterns: [Integrated, Actor] # composition (ADR-041): ONE inheritable spine + N kind:'capability' patterns.
                                #   two spines is a hard error; order is nesting order, rightmost outermost.
                                #   library capabilities: Actor (config required), Communication (ADR-041.1)
  context: crm                  # bounded context (ADR-0004); clean-lite-ps nests modules/<context>/<plural>/
  surface: crm                  # integration surface (ADR-0006) — drives integration codegen
  sync: api                     # frontend per-entity override: api | electric
  config:                       # per-pattern AND per-capability config, e.g. { Activity: { subject: account } },
                                #   { Actor: { kind: individual } } | { Actor: { kind: group, members: <has_many> } }

fields:
  email: { type: string, required: true, max_length: 255, index: true }
  status: { type: enum, choices: [active, inactive] }

relationships:
  account: { type: belongs_to, target: account, foreign_key: account_id }

roles:                          # needs `Communication` in patterns:; every target needs `Actor`.
                                #   Communication → repo findByRole(role, actorId) + participants(id), forwarded on the service
  host:      { target: contact, cardinality: one }                       # → belongs_to, FK host_contact_id, indexed, key `host`
  attendees: { target: contact, cardinality: many, via: meeting_contact } # → validated against junctions/, emits nothing

behaviors: [timestamps, soft_delete, user_tracking]

api: true                       # false → no HTTP surface (REST/Electric/tRPC); service + use cases still generated (ADR-043 §6)
generate:
  writes: true                  # false → no create/update/delete use cases or routes

queries:
  - by: [email]
    unique: true                # NOTE: emits an index, not a DB UNIQUE constraint (#484, #511)
  - by: [account_id]
    order: created_at desc
  - name: search                # → SearchXUseCase + GET /<plural>/search
    filters: [userId, accountId]
    search: name
    paginate: true

unique_indexes: [...]           # composite unique indexes
eav: true                       # paired *WithFields reads + transactional compound writes
eav_value_table: true           # this entity IS the value table (needs eav_definition_table)
eav_definition_table: field_definition
integration: { ... }            # providers / sink (exclude_fields, emit_changes)
detection: { ... }              # per-provider change detection
events: [...]                   # declared domain events
emits: ...
analytics: { ... }              # cube measures/metrics (generate.analytics: cube)
```

Full field reference: `consumer-skills/entities/yaml-reference.md`.

**EAV.** `eav: true` gives the service `findByIdWithFields` / `listWithFields`, and
create/update use cases accept a `fields` bag written through
`FieldValueService.upsertFieldsTransactional` inside one transaction. The service
never injects the value repository directly. `eav_value_table: true` gives the
value table `upsertCurrentValues(rows, tx)` and
`upsertFieldsTransactional` / `findMergedByEntity`.

## `codegen.config.yaml`

One schema, `CodegenConfigSchema` (`src/schema/codegen-config.schema.ts`), parsed once by
`src/config/project-config.ts` for the CLI context AND the hygen prompts (the CLI hands the prompts its resolved path
as `$CODEGEN_CONFIG_PATH`). Every block is `.strict()`: an unknown or removed key is a `CodegenConfigError` naming the
key and the file, exit 1 (CFG-0, #640). Open maps only: `jobs.pools.<name>`, `frontend.parsers`.

Top-level keys: `runtime`, `paths`, `generate`, `patterns`, `naming`, `locations`, `frontend`, `auth`, `database`,
`behaviors`, `dev`, `subsystems`, `events`, `jobs`, `bridge`, `integration`, `observability`, `openapi`, `cache`,
`storage`.

**Adding a key:** declare it in the schema with a comment naming its reader, and read it off the parsed config —
never `yaml.parse` the file. `src/__tests__/config/config-census.test.ts` greps every `paths.<key>` and top-level
read and fails on an undeclared one, and fails on any second loader — with no exceptions.

**The consumer's app never reads the file (CFG-1, #643).** Keys the app needs at boot — `openapi.*`,
`auth.devAllowAnonymous`, `jobs.pools` — are validated at generation and written into `<paths.generated>/app-config.ts`
(`openapiConfig`, `authConfig`, `jobPools`, `jobWorkerOptions` — GEN-0; `@generated`, rewritten by `project init`, every `entity new` /
`subsystem install`/`remove`, `subsystem install openapi-config`, `project upgrade-openapi` / `upgrade-auth`).
`main.ts`, the subsystem barrel and `worker.ts` import it; an emit-once file never holds a config value (the
standalone worker is `JobWorkerModule.forRoot(jobWorkerOptions)`, GEN-0 #652). Edit the YAML, then regenerate. A new boot-time key goes
into that module (`src/cli/shared/app-config-generator.ts`), never a runtime YAML read.

**A generated file the app imports is never optional output (JOBS-0, #655).** `modules.ts`, `schema.ts`,
`subsystems.ts` (+ its registry / events stubs), `subsystems-schema.ts` and `app-config.ts` are written through
`generating(file, step)` (`src/utils/generated-file.ts` — sync or async; a nested `GeneratedFileError` passes
through, so the innermost file is named), which rethrows any failure as a `GeneratedFileError`
naming the file (`writeAppConfig` / `syncAppConfig` wrap themselves); every command that regenerates them
(`entity new`, `relationship new`, `junction new`, `subsystem install` / `remove`, `subsystem install openapi-config`)
returns `reportRegenerationFailure(...)` — exit 1, never a warning; `project upgrade-openapi` / `upgrade-auth` exit 1
through their own catch. No rollback: a failed `entity new` post-step exits 1 with hygen's entity tree already written
and the barrels stale — fix the cause and re-run (idempotent). JOBS-1 (#660): so does every other `entity new`
post-step — scope-entity-type, event codegen (an error-severity issue included: it writes nothing), bridge registry
(a rejected trigger set included), orchestration, frontend, provider / adapter / assembly / job-handler emitters. Each
emitter's write helper wraps its own file; the CLI wraps each step in `generating(<step output root>, …)` so a failure
before any write names the step's output. Declared skips (bridge not installed, no entities, a surface with no port
package) stay informational. The dry-run orchestration *plan* still warns (it writes nothing). Invalid job YAML,
unloadable pattern files and provider blocking issues are pre-flight rejections (JOBS-2, CLI-1, above).

```yaml
runtime: package
paths:
  backend_src: src
  entities: entities                # entity YAML directory; default entities/
  generated: src/generated        # default <backend_src>/generated
  events_dir: events              # default events
  jobs_dir: definitions/jobs      # default
generate:
  architecture: clean-lite-ps     # clean | clean-lite-ps — schema default is clean; init writes clean-lite-ps
  frontend: false
  analytics: none                 # none | cube
patterns: [src/patterns/*.pattern.ts]   # default <backend_src>/patterns/*.pattern.ts
auth:
  devAllowAnonymous: false        # strict block; localhost-only escape hatch
```

Every `paths.*` key has ONE default, declared in `PathsConfigSchema` (PATH-0):
`backend_src: src`, `entities`, `events_dir: events`, `jobs_dir`, `providers`,
`frontend_src: apps/frontend/src`; `generated` / `modules_dir` /
`orchestration_src` derive from `backend_src`, and so does the `patterns:` default
(`<backend_src>/patterns/*.pattern.ts`, filled by `CodegenConfigSchema`'s top-level
transform). There is no `paths.subsystems` — the runtime root is
`<backend_src>/shared/subsystems` (`projectLayout(...).subsystems`). `modules_dir`
places every clean-lite-ps module: `entityModuleNaming(block, modulesDir)`
(`templates/_shared/entity-naming.mjs`), the junction / relationship prompts,
`barrel-generator.ts`, the integration assemblies (PATH-1). No file ⇒ `DEFAULT_CODEGEN_CONFIG`.
CLI code resolves directories through `projectLayout(cwd, config)`
(`src/cli/shared/project-layout.ts`) and emitted relative imports through
`importSpecifier(fromFile, toModule)` — never a `?? 'src'` literal (a test greps
for it). `project init` and every `subsystem install` honour a config written
before them (#566, #612).

## Entity families

All families get `findById`, `findByIds`, `list`, `count`, `exists`, `create`,
`update`, `delete`, `upsertMany`. Writes take an optional `tx`.

| Family | Adds |
|---|---|
| Integrated | `findByExternalId`, `findAllByUserId`, `findVisibleByUserId`, `integrationUpsert` |
| Activity | `findByDateRange`, `findByUserId`, `findBySubjectId`, `findRecentBySubjectId` |
| Metadata | `findByEntityIdAndType`, `listByEntityId`, `listHistoryByEntityId` |
| Knowledge | `semanticSearch`, `findPendingByOpportunityId`, `updateStatus`, `updateStatusBatch` (stub) |
| Base | CRUD only |

## Generated HTTP surface + auth (ADR-043, 0.30.0)

- The data plane is **closed by default**. `AuthModule.forRoot` binds
  `AuthenticatedGuard` as `APP_GUARD`: a non-`@Public()` route without an ambient
  `RequesterContext` returns 401.
- The generated `main.ts` calls `installRequesterContext(app)` and refuses to
  `listen()` when no `IUserContext` is bound under `AUTH_USER_CONTEXT`, unless
  `auth.devAllowAnonymous: true` (read as the generated `authConfig`, CFG-1).
  The probe is the runtime's `resolveUserContext(app)`, on an app created with
  `abortOnError: false` — Nest's default turns the unbound lookup into
  `process.exit(1)` (#651). `worker.ts` never gets this check.
- Controllers take **no** `x-user-id` / `x-tenant-id` headers. Use cases get the
  actor from `tryGetRequester()` (ALS). Don't reintroduce header-sourced identity.
- Upgrading an existing app: `codegen project upgrade-auth` (idempotent AST
  codemod), then bind an `IUserContext`.
- Controllers pipe `@Body()` through `ZodValidationPipe` (422, RFC 7807), return
  404 from `GET :id` for missing or soft-deleted rows, and carry Swagger decorators
  including `@ApiBearerAuth()`.
- Tenant scoping at the repository level is designed in ADR-042 but not built yet.

## Layer rules (ADR-003 / ADR-004)

- **Repository** — one table, extends a pattern base, no business logic.
- **Service** — aggregate API boundary. May read across domains; must not write across domains.
- **Use case** — workflow. Composes services, owns the transaction for cross-domain writes, emits events.
- **Controller** — thin; calls use cases only.

## Working on the generator

- Backend: hygen templates (`templates/entity/new/backend/` = clean,
  `templates/entity/new/clean-lite-ps/` = clean-lite-ps). Frontend and integration: TS emitters in `src/emitters/`.
- Gates: `just test-unit`, `just test-baseline` (regenerate snapshots when output
  changes intentionally), `just test-smoke`, `just test-post-publish` (tarball).
- Every smoke fails on any `tsc` diagnostic located in the project it generated.
  `test/smoke/_consumer-errors.ts` drops a diagnostic only by **location** (outside
  that project, or in `node_modules`), never by message or directory (GATE-2, #604).
- clean-lite-ps bodies render under `architecture: clean` too (`skip_if` stops the
  write, not the render). Each body opens with one guard,
  `<%_ if (typeof clpOutputPaths !== 'undefined') { -%>`, and inside it every local is
  referenced **unguarded**: never `typeof x !== 'undefined' ? x : <fallback>`. A missing
  local must throw (#638, grep-asserted in `src/__tests__/clean-lite-ps/strict-locals.test.ts`).
  A new runtime import specifier goes in `runtimeImportLocals` (`src/config/runtime-mode.mjs`);
  unit tests get the prompt-owned locals from `withEntities()` (`src/__tests__/clean-lite-ps/_entity-lookup.ts`).
- Releases: a version bump merged to main publishes. If the version is already on
  npm, the CI publish job is a **green no-op** — always bump alongside
  consumer-visible changes, and add a `CHANGELOG.md` entry.
