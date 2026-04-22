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
  pattern: Synced                   # Synced | Activity | Metadata | Knowledge | Base (or app-defined)

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
codegen subsystem install sync       # external-system sync engine (IChangeSource + orchestrator + audit log)
codegen subsystem install bridge     # event-to-job bridge (durable async fanout via @JobHandler.triggers)
codegen subsystem list               # show installed + available

codegen events consumers <type>      # list all Tier 1/2/3 consumers of an event type
```

Each subsystem generates a protocol (interface), Drizzle backend (Postgres), memory backend (tests), and a NestJS module with `forRoot({ backend })` factory.

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

## Entity Families

Families provide pre-built base classes with domain-specific query patterns:

| Family | When to Use | Key Methods |
|--------|-------------|-------------|
| `synced` | CRM-synced entities (contacts, accounts) | `findByExternalId`, `syncUpsert`, `findAllByUserId` |
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

## Configuration

`codegen.config.yaml` in your project root:

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
```

Auto-detect your project's conventions with `codegen project scan`.

## Using in Your Project

See [docs/CONSUMER-SETUP.md](docs/CONSUMER-SETUP.md) for the full consumer contract: tsconfig path aliases, `DatabaseModule` scaffold, runtime shims, and the one-time `app.module.ts` wire-up.

See [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for a walkthrough of entity YAML authoring.

## Project Layout

```
src/                        Generator source code
  cli/                      Clipanion CLI (noun-verb architecture)
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
templates/                  Hygen EJS templates
test/                       Baseline snapshots, scaffold integration, smoke test
docs/                       ADRs, consumer setup, getting started
```

## License

MIT
