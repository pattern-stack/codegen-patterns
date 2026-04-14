# @pattern-stack/codegen

Code generation CLI for NestJS + Drizzle applications. Generates entities, repositories, services, controllers, DTOs, use cases, and infrastructure subsystems from YAML definitions.

## When to Use This Skill

Use when the user asks to:
- Create, scaffold, or generate an entity / module / feature
- Add an API endpoint or CRUD resource
- Install infrastructure (events, jobs, cache, storage)
- Set up or initialize a codegen project
- Start, stop, or check the dev environment
- Validate entity YAML definitions

## CLI Reference

The CLI uses a noun-verb pattern. Every noun supports `--json` for machine-readable output and `--cwd <path>` to target a specific project.

### Entity Commands

```bash
codegen entity                           # summary: defined entities, families, queries
codegen entity new <yaml>                # generate one entity from YAML
codegen entity new --all                 # regenerate all entities in entities/
codegen entity new --all --dry-run       # preview what would be generated
codegen entity new --all --force         # overwrite without git-safety check
codegen entity list                      # tabular list of all entities
codegen entity list --format json        # machine-readable entity list
codegen entity validate                  # check YAML schema + cross-references
codegen entity validate --strict         # treat warnings as errors
```

After every generation run, barrel files are regenerated:
- `src/generated/modules.ts` — exports `GENERATED_MODULES` array
- `src/generated/schema.ts` — re-exports all entity Drizzle schemas

The user wires these into `app.module.ts` once; codegen never touches that file again.

### Subsystem Commands

```bash
codegen subsystem                        # summary: installed vs available
codegen subsystem install events         # domain event bus (transactional outbox)
codegen subsystem install jobs           # background job queue
codegen subsystem install cache          # key-value cache with TTL
codegen subsystem install storage        # file storage
codegen subsystem install events --backend redis    # Redis Pub/Sub backend
codegen subsystem install cache --backend memory    # memory-only (tests)
codegen subsystem install events --dry-run          # preview install
codegen subsystem list                   # show installed + available
```

Each subsystem follows Protocol → Backend → Factory (ADR-008). Register via `forRoot({ backend })`.

### Project Commands

```bash
codegen init                             # scaffold a new consumer project (shortcut)
codegen project init --yes               # accept all defaults, no prompts
codegen project init --dry-run           # preview scaffold plan
codegen project scan                     # detect conventions → propose config
codegen project scan --write             # write detected config to codegen.config.yaml
codegen project config                   # show resolved config
codegen project inspect --kind analyze   # cross-entity dependency graph
codegen project inspect --kind stats     # entity statistics
codegen project inspect --kind doc       # markdown domain documentation
```

### Dev Environment Commands

```bash
codegen dev                              # summary: service health, entities, endpoints
codegen dev up                           # start Docker (Postgres + Redis), push schema, start app
codegen dev up --no-app                  # start Docker only, skip NestJS app
codegen dev status                       # dashboard with health checks
codegen dev logs                         # tail app logs
codegen dev logs --docker                # tail Docker service logs
codegen dev restart                      # restart app, keep Docker
codegen dev down                         # stop everything
codegen dev down --volumes               # stop + wipe data volumes
```

### Update

```bash
codegen update                           # pull latest + reinstall from source
```

## Entity YAML Schema

```yaml
entity:
  name: contact                          # singular snake_case
  plural: contacts
  table: contacts
  family: synced                         # synced | activity | metadata | knowledge

fields:
  email:
    type: string                         # string | integer | decimal | boolean | uuid | date | datetime | json | enum
    required: true
    max_length: 255
    index: true
  status:
    type: enum
    choices: [active, inactive]

behaviors:
  - timestamps                           # createdAt, updatedAt
  - soft_delete                          # deletedAt + automatic query filtering
  - user_tracking                        # createdBy, updatedBy

relationships:
  account:
    type: belongs_to                     # belongs_to | has_many | has_one
    target: account
    foreign_key: account_id

queries:
  - by: [email]                          # → FindContactByEmailUseCase
    unique: true
  - by: [account_id]                     # → FindContactByAccountIdUseCase
    order: created_at desc
```

## Configuration (`codegen.config.yaml`)

```yaml
paths:
  backend_src: src
  entities_dir: entities
  generated: src/generated

generate:
  architecture: clean-lite-ps            # clean | clean-lite-ps
  frontend: false

naming:
  fileCase: kebab-case
  suffixStyle: dotted
  terminology:
    command: use-case
    query: use-case
```

## Entity Families

| Family | Key Methods |
|--------|-------------|
| `synced` | `findByExternalId`, `syncUpsert`, `findAllByUserId` |
| `activity` | `findByDateRange`, `findRecentByOpportunityId` |
| `metadata` | `findByEntityIdAndType`, `upsertMany` |
| `knowledge` | Stub (needs pgvector) |

## Common Workflows

### Add a new entity
1. Create `entities/<name>.yaml`
2. `codegen entity new entities/<name>.yaml`
3. Barrels auto-update — no manual wiring

### Add infrastructure
1. `codegen subsystem install events`
2. Register: `EventsModule.forRoot({ backend: 'drizzle' })` in app.module.ts
3. Inject: `@Inject(EVENT_BUS) private eventBus: IEventBus`

### Initialize a new project
1. `codegen init --yes`
2. `bun add @nestjs/common @nestjs/core drizzle-orm reflect-metadata`
3. Create entity YAMLs, run `codegen entity new --all`

### Start dev environment
1. `codegen dev up` (requires Docker)
2. App on `localhost:3000`, check with `codegen dev status`
