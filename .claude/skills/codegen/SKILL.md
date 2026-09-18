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
codegen entity new --all                  # every YAML under paths.entities_dir (default entities/)
codegen entity new --all --only <names>   # subset
codegen entity new --all --dry-run | --force | --continue-on-error
codegen entity list [--pattern <P>] [--format json]
codegen entity validate [dir] [--strict]  # schema + cross-refs; --strict fails on warnings

codegen relationship new <yaml> | --all   # relationships/ — junction tables between entities
codegen relationship list
codegen junction new <yaml> | --all       # junctions/ — first-class M:N with role/temporal/sourcing metadata
codegen junction list
```

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
codegen project scan [--write]             # detect framework/ORM/architecture → propose config
codegen project config                     # resolved config
codegen update | project update [--dry-run] [--force] [--skip-skills] [--skip-subsystems]
codegen project upgrade-auth [--dry-run] [--path <dir>]      # ADR-043 wiring (see Auth below)
codegen project upgrade-openapi [--dry-run] [--force] [--path <dir>]
codegen project inspect --kind analyze|stats|doc|manifest|suggestions
codegen project graph [--output graph.json]
```

`init` (package mode, the default) writes: `codegen.config.yaml`,
`src/shared/database/database.module.ts`, `src/generated/{modules,schema}.ts`,
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

Changes to emitted imports must work in both modes. The tarball smoke
(`just test-post-publish`) covers package mode from the packed artifact.

## Entity YAML

```yaml
entity:
  name: contact                 # singular snake_case
  plural: contacts
  table: contacts
  pattern: Integrated           # Integrated | Activity | Metadata | Knowledge | Base | app-defined (ADR-031)
  context: crm                  # bounded context (ADR-0004); clean-lite-ps nests modules/<context>/<plural>/
  surface: crm                  # integration surface (ADR-0006) — drives integration codegen
  sync: api                     # frontend per-entity override: api | electric
  config:                       # per-pattern config, e.g. { Activity: { subject: account } }

fields:
  email: { type: string, required: true, max_length: 255, index: true }
  status: { type: enum, choices: [active, inactive] }

relationships:
  account: { type: belongs_to, target: account, foreign_key: account_id }

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
analytics: { ... }              # composite metrics: ratio | derived | cumulative (SEM-1)
                                # field tags: role / agg / aggs / additivity / time
```

Full field reference: `consumer-skills/entities/yaml-reference.md`.

**EAV.** `eav: true` gives the service `findByIdWithFields` / `listWithFields`, and
create/update use cases accept a `fields` bag written through
`FieldValueService.upsertFieldsTransactional` inside one transaction. The service
never injects the value repository directly. `eav_value_table: true` gives the
value table `upsertCurrentValues(rows, tx)` and
`upsertFieldsTransactional` / `findMergedByEntity`.

## `codegen.config.yaml`

Top-level keys: `runtime`, `paths`, `locations`, `generate`, `naming`,
`patterns`, `frontend`, `auth`, `openapi`, `jobs`.

```yaml
runtime: package
paths:
  backend_src: src
  entities_dir: entities
  generated: src/generated
  events_dir: events              # default <cwd>/events
  jobs_dir: definitions/jobs      # default
generate:
  architecture: clean-lite-ps     # clean | clean-lite-ps — schema default is clean; init writes clean-lite-ps
  frontend: false
  semantic: false                 # emit <generated>/semantic/ — the declared AggregateModel (SEM-2)
patterns: [src/patterns/*.pattern.ts]
auth:
  devAllowAnonymous: false        # strict block; localhost-only escape hatch
```

Known gap: `init` and subsystem scaffolds still emit to root `src/` in places,
ignoring `paths.backend_src` (#527, #566).

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
  `auth.devAllowAnonymous: true`. `worker.ts` never gets this check.
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
- The smoke harness filters tsc output. `filterConsumerErrors` drops any line
  containing `../` or `node_modules/`, so a passing smoke does not rule out broken
  relative imports (#576). To be sure, run `KEEP_SMOKE_DIR=1` and then an
  unfiltered `bunx tsc --noEmit --skipLibCheck` in the kept directory.
- Releases: a version bump merged to main publishes. If the version is already on
  npm, the CI publish job is a **green no-op** — always bump alongside
  consumer-visible changes, and add a `CHANGELOG.md` entry.
