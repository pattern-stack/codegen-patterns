# codegen-patterns

Define entities in YAML. Generate a full NestJS + Drizzle backend — repositories, services, controllers, DTOs, use cases, module wiring — in one command.

```bash
codegen entity new entities/contact.yaml
```

Built for teams that want consistent architecture without hand-writing the same CRUD scaffolding for every entity. Works with two backend layouts (full Clean Architecture or Clean-Lite-PS) and generates infrastructure subsystems (events, jobs, cache, storage) following Protocol → Backend → Factory patterns.

## Install

```bash
bun install                       # install deps
mise install                      # pin bun + node versions (optional, recommended)
```

## Define an Entity

```yaml
# entities/contact.yaml
entity:
  name: contact
  plural: contacts
  table: contacts
  pattern: Integrated               # Integrated | Activity | Metadata | Knowledge | Base (or app-defined)

fields:
  email:
    type: string
    required: true
    max_length: 255
    index: true
  first_name:
    type: string
    required: true
  status:
    type: enum
    choices: [active, inactive]

behaviors:
  - timestamps                      # createdAt, updatedAt
  - soft_delete                     # deletedAt + automatic query filtering

relationships:
  account:
    type: belongs_to
    target: account
    foreign_key: account_id

queries:
  - by: [email]
    unique: true
  - by: [account_id]
    order: created_at desc
```

## Generate

```bash
codegen entity new entities/contact.yaml     # one entity
codegen entity new --all                     # all entities
codegen entity validate                      # check YAML before generating
codegen entity list                          # see what's defined
```

Every run regenerates barrel files (`src/generated/modules.ts` and `src/generated/schema.ts`) so your `app.module.ts` never needs editing after the initial one-line wire-up.

## CLI

The CLI uses a noun-verb pattern. Running any noun alone shows its current state and suggests next steps:

```bash
codegen                          # project overview
codegen entity                   # entity summary + hints
codegen subsystem                # installed vs available
codegen project                  # config + framework detection
```

### Entity Commands

```bash
codegen entity new <yaml>        # generate from YAML
codegen entity new --all         # regenerate all entities
codegen entity new --dry-run     # preview without writing
codegen entity list              # tabular entity list
codegen entity validate [dir]    # schema + cross-reference checks
```

### Subsystem Commands

```bash
codegen subsystem install events     # domain event bus (transactional outbox)
codegen subsystem install jobs       # background job queue (pg-boss pattern)
codegen subsystem install cache      # key-value cache with TTL
codegen subsystem install storage    # file storage (local filesystem)
codegen subsystem install integration # external-system integration engine (IChangeSource + orchestrator + audit log)
codegen subsystem install bridge     # event-to-job bridge (durable async fanout via @JobHandler.triggers)
codegen subsystem install openapi-config  # OpenAPI/Swagger — Zod DTOs as /docs-json + Swagger UI. See docs/CONSUMER-SETUP.md §OpenAPI
codegen subsystem install auth       # OAuth integration auth (AuthModule + ports + state store + AuthController)
codegen subsystem install auth-integrations  # vendored integrations entity + adapters (consumes auth subsystem)
codegen subsystem list               # show installed + available

codegen events consumers <type>      # list all Tier 1/2/3 consumers of an event type
```

Each subsystem generates a protocol (interface), Drizzle backend (Postgres), memory backend (tests), and a NestJS module with `forRoot({ backend })` factory. The `openapi-config` subsystem is config-only — the runtime helpers ship with `codegen project init`.

### Project Commands

```bash
codegen init                     # scaffold a new consumer project
codegen project scan             # detect conventions → propose config
codegen project config           # view resolved config
```

## What Gets Generated

**Clean Architecture** (default, `generate.architecture: clean`):
```
domain/{entity}/                   Entity class + repository interface
application/commands/{entity}/     Create, Update, Delete use cases
application/queries/{entity}/      GetById, List, declarative queries
infrastructure/persistence/        Drizzle schema + repository impl
presentation/rest/                 REST controller
modules/                           NestJS module wiring
```

**Clean-Lite-PS** (`generate.architecture: clean-lite-ps`):
```
modules/{plural}/
  {entity}.entity.ts               Drizzle table + types
  {entity}.repository.ts           Extends pattern base class
  {entity}.service.ts              Extends pattern base service
  {entity}.controller.ts           REST endpoints
  {plural}.module.ts               NestJS module
  dto/                             Create, Update, Output DTOs
  use-cases/                       FindById, List, declarative queries
```

**Frontend** (`generate.frontend: true`) — see [Frontend generation](#frontend-generation) below.

## Frontend generation

Gated entirely by `generate.frontend` (default `false`; the scanner sets it
`true` when it finds an `apps/frontend/` directory). When on, the `entity new`
post-step (and therefore `gen-all`) renders the **complete frontend tree from the
full entity set in one pass** — a TypeScript emitter (`src/emitters/frontend/`),
not hygen templates. Re-running is idempotent: every file is a complete-file
write with a `@generated` banner, no inject/anchor machinery, no overwrite
prompts (ADR-038).

Output lands under `locations.frontendGenerated` (default
`apps/frontend/src/generated/`):

```
generated/
  index.ts                 whole-set barrel (+ version-pairing comment)
  config.ts                per-entity sync modes + runtime overrides
  query-client.ts          shared TanStack QueryClient
  api/<entity>.ts          REST client → the generated NestJS controllers
  collections/<entity>.ts  createCollection, branched on the entity's sync mode
  entities/<entity>.ts     createEntityHooks({ collection, api }) wiring
  store/index.ts           createStore over the full set (+ resolvers, lookups)
  fields/<entity>.ts       field metadata (FieldMeta, <entity>Fields)
  providers.ts             providers catalog — only when definitions/providers/ exists
```

Entity types and Zod schemas are **imported** from `locations.dbEntities`
(default `@repo/db/entities`), not re-emitted. The emitter imports the plain
class name — `import type { <Class> } from '<dbEntities>/<name>'` — so
`dbEntities` is the contract: it MUST export the entity type under its plain
`<Class>` name (e.g. `Contact`, not `ContactEntity`). If your db package only
exports `<Class>Entity`, that is the one knob to change in the emitter.

The hook/mutation/store/provider logic is consumed from
`@pattern-stack/frontend-patterns` (`createEntityHooks`, `createStore`) — the
generated files are thin wiring. **The consumer's frontend installs that package
plus the paired TanStack libraries.** `project init` adds the version-pairing
deps to `apps/frontend/package.json` when `generate.frontend: true` (idempotent
merge — only missing keys added, existing version ranges preserved); when no
frontend package.json exists it prints the list to install. `@pattern-stack/codegen`
itself gains no runtime dependency.

| Package | Range |
|---|---|
| `@pattern-stack/frontend-patterns` | `^0.2.0-alpha.18` |
| `@tanstack/react-db` | `^0.1.55` |
| `@tanstack/electric-db-collection` | `^0.2.11` |
| `@tanstack/query-db-collection` | `^1.0.6` |
| `@tanstack/react-query` | `^5.0.0` |

### `frontend:` config block

All knobs are inert unless `generate.frontend: true`. Defaults shown; the block
is optional (fully defaulted when absent):

```yaml
frontend:
  auth:
    function: getAuthorizationHeader   # auth-header fn; null DISABLES the header
  parsers:                             # Electric column-type → parser fn source
    timestamptz: '(date: string) => new Date(date)'
  sync:
    mode: electric          # global default sync mode (api | electric)
    shapeUrl: /v1/shape      # Electric shape base path
    useTableParam: true      # emit `params: { table }` shape-URL form
    columnMapper: snakeCamelMapper   # Electric column mapper fn; null to omit
    columnMapperNeedsCall: true      # call the mapper (fn()) vs reference (fn)
    apiBaseUrlImport: null   # when set, import API_BASE_URL from it as baseURL
    apiUrl: /api             # REST base path when no apiBaseUrlImport
  fields:
    textareaThreshold: 500  # string→textarea cutoff (strict >); null DISABLES
```

`null`-disables convention: an **absent** `auth.function` defaults to
`getAuthorizationHeader`; an **explicit `null`** disables it entirely (no header
lines emitted). Likewise `sync.columnMapper: null` omits the Electric mapper, and
`fields.textareaThreshold: null` disables the string→textarea heuristic entirely
(bounded strings always render as `text` unless the author sets `ui_type: textarea`).

### Per-entity sync mode (`entity.sync`)

Each entity may override the global `frontend.sync.mode` inside its `entity:`
block (sibling to `surface:`/`context:`):

```yaml
entity:
  name: contact
  plural: contacts
  table: contacts
  sync: api        # api | electric — overrides frontend.sync.mode for this entity
```

`api` wires `queryCollectionOptions` (REST via TanStack Query); `electric` wires
`electricCollectionOptions` (real-time shape sync). Absent → the global default.
`offline` (Electric + Dexie) is deferred — the schema rejects it.

Cross-entity FK names (file, plural, class, collection var) are resolved against
the **target entity's own YAML** via the registry — never re-pluralized from a
string at emit time (so an explicit `plural:` like `person`→`persons` is honored
by every consumer).

### Providers catalog (`providers.ts`)

Providers are gen-time knowledge (`definitions/providers/<slug>.yaml`,
RFC-0001) — the provider set changes only when code deploys — so the frontend
catalog is **emitted, not queried**. When the project has provider definitions,
the emitter renders `generated/providers.ts`:

- `PROVIDERS` — every provider, flat (active + planned), slug-sorted:
  `{ provider, name, planned, surfaces, blurb?, hint? }`. Join live rows on
  `provider` (the canonical slug, e.g. `Connection.provider`).
- `PROVIDER_CATALOG` — grouped into `frontend.catalog.categories` (config
  order) via each provider's `display.category`. Uncategorized providers
  appear only in `PROVIDERS`.

Two provider-YAML additions feed it:

```yaml
# definitions/providers/google.yaml (active — full definition)
slug: google
display_name: Google Workspace
display:
  category: google-workspace     # joins frontend.catalog.categories[].id
  hint: connect                  # optional sub-line on an unconnected tile
surfaces: [calendar, mail, transcript]
auth: { ... }                    # required for active providers
client: { ... }

# definitions/providers/github.yaml (planned — roadmap stub)
slug: github
display_name: GitHub
status: planned                  # catalog tile only; NO backend emission,
display:                         # no auth/client required, surface + import
  category: source-control       # cross-checks skipped
surfaces: [source_control]
```

```yaml
# codegen.config.yaml — the ordered display groups
frontend:
  catalog:
    categories:
      - id: source-control
        name: Source Control & Issues
        blurb: Repositories, pull requests, issues, and project planning
```

When the integration for a `planned` provider lands, flip it to `status:
active` (or drop the key) and add `auth`/`client` — the definitions tree is
the integration roadmap.

## Integration Codegen (provider/adapter + assembly + read primitive)

When an entity carries a `surface:` tag and `definitions/providers/*.yaml` exist,
re-running `codegen entity new` emits the **full** integration layer for each
`(surface, provider, entity)` — not just the read side. The author fills only the
irreducible vendor seam: the `enumerate` / `hydrate` / `toCanonical` read methods
and any non-generic sink write logic.

**Read side** (provider/adapter — RFC-0001):
```
integrations/providers/<provider>/      Auth strategy + client (provider module)
integrations/<surface>/adapters/<provider>/  Adapter scaffold: changeSources container
integrations/<surface>/<surface>-adapters.module.ts  Aggregator → <SURFACE>_ENTITY_SOURCES registry
integrations/<surface>/types.generated.ts            Typed views
```

The adapter *contributes* `changeSources` (per-entity, keyed by entity name); the
aggregator folds every provider's contributions into the entity-keyed
`<SURFACE>_ENTITY_SOURCES` registry consumers read at runtime.

**Read primitive** (RFC-0003): for interaction surfaces (mail / calendar /
transcript) each `changeSources` entry is emitted as an emit-once
`IncrementalReadBase<Canonical<Entity>, ResolvedFilter[]>` subclass — the
enumerate/hydrate read capability (`@pattern-stack/codegen/subsystems`). The base
owns streaming, **filter-before-hydrate**, bounded-concurrency hydration, and
per-ref cursor emission, so the buffer-all/serial/run-final-cursor regression is
structurally unwritable; the author fills only `enumerate` / `hydrate` /
`toCanonical`.

**Write/run side** (assembly — RFC-0002):
```
integrations/<surface>/modules/<provider>/<entity>-integration.module.ts  @generated per-entity assembly
integrations/<surface>/sinks/<entity>.sink.ts            emit-once default sink scaffold
integrations/<surface>/<surface>-integration.module.ts   @generated aggregator
integrations/<surface>/<surface>-integration.tokens.ts   @generated use-case tokens
```

Each per-entity module binds `INTEGRATION_CHANGE_SOURCE`
(= `adapter.changeSources['<entity>']`) + `INTEGRATION_SINK`, provides a local
`ExecuteIntegrationUseCase`, and exports a uniquely-tokened handle
(`<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>`) a trigger grabs to run a sync. The
default sink scaffolds over the entity's generated `Integrated` repository
(`pattern: Integrated` only); the author overrides any non-generic write logic.

## Entity Families

Families provide pre-built base classes with domain-specific query patterns:

| Family | When to Use | Key Methods |
|--------|-------------|-------------|
| `integrated` | externally-integrated entities (contacts, accounts) | `findByExternalId`, `integrationUpsert`, `findAllByUserId` |
| `activity` | Time-based events (emails, calls, meetings) | `findByDateRange`, `findRecentByOpportunityId` |
| `metadata` | Key-value data (tags, custom fields) | `findByEntityIdAndType`, `upsertMany` |
| `knowledge` | Vector-searchable content | Stub (needs pgvector) |
| *(none)* | Generic CRUD | Base repository + service only |

## Declarative Queries

The `queries:` block generates typed repository methods, use case classes, and module registration:

```yaml
queries:
  - by: [email]              # → FindContactByEmailUseCase (unique)
    unique: true
  - by: [account_id]         # → FindContactByAccountIdUseCase (ordered)
    order: created_at desc
  - by: [user_id, status]    # → FindContactByUserIdAndStatusUseCase (compound)
```

## Integration Detection (`detection:` block)

Entities that participate in the integration subsystem may declare a `detection:` block describing how upstream changes are detected. The block is parsed by the canonical `DetectionConfigSchema` shipped from `runtime/subsystems/integration` — primitives (`PollChangeSource<T>`, `WebhookChangeSource<T>`) and the per-entity factory module emitted by codegen consume the same parsed shape, so YAML and runtime stay in lockstep (ADR-033, epic #226).

```yaml
detection:
  mode: poll                       # poll | webhook
  poll:
    cursor:
      kind: systemModstamp         # systemModstamp | replayId | timestamp | eventId
      field: SystemModstamp
    provenance: poll               # 'poll' (default) or 'cdc' for Stripe-style event endpoints
  mapping:
    - source: Name
      target: name
    - source: Amount
      target: amount
      transform: decimal-string    # opt-in tag adapters interpret
  filters:                         # flat AND of resolved triples
    - field: IsDeleted
      op: eq                       # eq | neq | in | nin | gt | gte | lt | lte
      value: false
```

`webhook` mode requires a `webhook.eventIdField` naming the column on the consumer-owned inbound staging row that populates `Change<T>.dedupKey`. The block is optional and additive — entities without a `detection:` block are unaffected. Codegen emission of the per-entity factory module lands in #226-7; this PR validates the schema only.

## Configuration

`codegen.config.yaml` in your project root:

Definition directories (`entities_dir`, `events_dir`) are discovered
recursively — a flat `entities/contact.yaml` and a domain-foldered
`entities/crm/contact.yaml` are both picked up. Group definitions into
per-domain subfolders freely; codegen walks the whole tree.

```yaml
paths:
  backend_src: src
  entities_dir: entities
  events_dir: events
  generated: src/generated

generate:
  architecture: clean-lite-ps    # clean | clean-lite-ps
  frontend: false                # default false; scanner detects apps/frontend/
  commands: true
  queries: true

naming:
  fileCase: kebab-case
  suffixStyle: dotted            # .entity.ts vs Entity.ts
  terminology:
    command: use-case
    query: use-case

# frontend:                      # inert unless generate.frontend: true
#   ...                          # see "Frontend generation" above for the full block
```

The `frontend:` block (auth, parsers, sync) is documented under
[Frontend generation](#frontend-generation). Auto-detect your project's
conventions with `codegen project scan`.

## Using in Your Project

See [docs/CONSUMER-SETUP.md](docs/CONSUMER-SETUP.md) for the full consumer contract: tsconfig path aliases, `DatabaseModule` scaffold, runtime shims, and the one-time `app.module.ts` wire-up.

See [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for a walkthrough of entity YAML authoring.

## Project Layout

```
src/                        Generator source code
  cli/                      Clipanion CLI (noun-verb architecture)
  emitters/                 TypeScript emitters (integration, frontend — ADR-038)
  analyzer/                 Graph building, consistency checking
  parser/                   YAML loading, cross-reference resolution
  scanner/                  Project pattern detection
  schema/                   Zod validation schemas
  behaviors/                Shared behaviors (timestamps, soft-delete)
  config/                   Config loader, paths, naming
  formatters/               Console, JSON, markdown output
  __tests__/                Unit tests (mirrors src/ structure)
runtime/                    Code shipped into consumer projects
  base-classes/             BaseRepository, BaseService, pattern bases
  subsystems/               Events, Jobs, Cache, Storage
templates/                  Hygen EJS templates (backend pipelines)
test/                       Baseline snapshots, scaffold integration, smoke test
docs/                       ADRs, consumer setup, getting started
```

## License

MIT
