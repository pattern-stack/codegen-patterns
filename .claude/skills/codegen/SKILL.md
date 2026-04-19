# @pattern-stack/codegen

Code generation CLI for NestJS + Drizzle applications. Generates entities, repositories, services, controllers, DTOs, use cases, OAuth-ready integrations, and infrastructure subsystems from YAML definitions.

## When to Use This Skill

Use when the user asks to:
- Create, scaffold, or generate an entity / module / feature
- Add an API endpoint or CRUD resource
- Opt an entity into EAV (custom fields)
- Mark a table as an EAV value-table (compound methods auto-generated)
- Install infrastructure (events, jobs, cache, storage)
- Set up or initialize a codegen project
- Start, stop, or check the dev environment
- Validate entity YAML definitions

## CLI Reference

Noun-verb pattern. Every noun supports `--json` for machine-readable output and `--cwd <path>` to target a specific project.

**See also:** `.claude/primitives/codegen/clean-lite-ps.md` for the full YAML schema reference.

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
codegen subsystem remove <name>          # uninstall a subsystem
```

Each subsystem follows Protocol → Backend → Factory (ADR-008). Register via `forRoot({ backend })`.

### Relationship Commands

First-class junction tables between entities. YAML files live in `relationships/`.

```bash
codegen relationship new <yaml>          # generate one relationship from YAML
codegen relationship new --all           # regenerate all in relationships/
codegen relationship new --all --dry-run # preview
codegen relationship new <yaml> --force  # overwrite without git-safety check
codegen relationship list                # tabular list of relationship defs
```

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
codegen project inspect --kind manifest  # refresh/inspect project manifest
codegen project inspect --kind suggestions  # review suggested actions
codegen project graph                    # open interactive ER graph viewer
codegen project graph --output graph.json   # export graph JSON
```

`codegen init` scaffolds the consumer's shared layer (as of PR #55):
- `src/shared/base-classes/*` — family bases with optional `tx?: DrizzleTx` on writes
- `src/shared/constants/tokens.ts` — `DRIZZLE` DI symbol
- `src/shared/types/drizzle.ts` — `DrizzleClient` + `DrizzleTx` type aliases
- `src/shared/http/zod-validation.pipe.ts` — runtime Zod validation on `@Body()`
- `src/shared/eav-helpers.ts` — pure `toEavRows` + `mergeEavRows`

These files are source of truth; don't hand-edit. Rerun `codegen init` to refresh them.

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
  family: synced                         # synced | activity | metadata | knowledge | base

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

# Optional top-level flags (PR #52 / #53 / #55)
eav: true                                # emit paired reads + compound-write use cases for EAV
eav_value_table: true                    # THIS entity IS the EAV value table
eav_definition_table: field_definition   # where the value table resolves keys → ids

generate:
  writes: true                           # emit POST/PATCH/DELETE + create/update/delete use cases (default true)

queries:
  - by: [email]                          # → FindContactByEmailUseCase
    unique: true
  - by: [account_id]                     # → FindContactByAccountIdUseCase
    order: created_at desc
  - name: search                         # PR #54: → SearchContactsUseCase + GET /contacts/search
    filters: [userId, accountId, email]
    search: name                         # ilike column
    paginate: true                       # returns { items, total, limit, offset }
```

### `eav: true` — auto-generated EAV routes on a consumer entity

When set on an entity (e.g. `opportunity`):

- Service gains **paired read methods**: `findById` (typed entity only) and `findByIdWithFields` (entity + merged `fields` bag). Same for `list` / `listWithFields`.
- Use cases: `CreateXUseCase` and `UpdateXUseCase` accept `{ ...core, fields?: Record<string, unknown> }` and run a transactional dual-write via `FieldValueService.upsertFieldsTransactional`.
- Controller routes: `GET /:id/with-fields`, `GET /with-fields`, `POST / PATCH` accept the `fields` bag.

Service never injects `FieldValueRepository` directly — composition goes through `FieldValueService` (consumer's EAV value-table service — see `eav_value_table` below).

### `eav_value_table: true` — mark an entity as THE EAV value table

When set on the value-table entity (e.g. `field_value`):

- Repository gets `upsertCurrentValues(rows, tx)` with composite `(entity_type, entity_id, field_definition_id)` conflict target.
- Service gets `upsertFieldsTransactional(entityType, entityId, userId, fields, tx)` and `findMergedByEntity(entityType, entityId)` with internal FieldDefinition-id resolution.
- Module auto-imports the definition-table module so DI resolves without consumer wiring.

Requires companion `eav_definition_table: '<entity_name>'` pointing at the definition table.

Consumer writes zero code for the EAV compound operations. They get them generated.

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

All families inherit the standard CRUD set: `findById`, `findByIds`, `list`, `count`, `exists`, `create`, `update`, `delete`, `upsertMany`. All write methods accept an optional `tx?: DrizzleTx` for transactional composition.

| Family | Additional Methods |
|--------|--------------------|
| `synced` | `findByExternalId`, `findAllByUserId`, `findVisibleByUserId`, `syncUpsert` |
| `activity` | `findByDateRange`, `findByUserId`, `findByOpportunityId`, `findRecentByOpportunityId` |
| `metadata` | `findByEntityIdAndType`, `listByEntityId`, `listHistoryByEntityId` |
| `knowledge` | `semanticSearch`, `findPendingByOpportunityId`, `updateStatus`, `updateStatusBatch` (pgvector at runtime) |
| `base` | Standard CRUD only |

**Dealbrain v2 usage:**
- `synced` → `opportunity`, `account`, `contact` (CRM triad per `specs/2026-04-16-crm-sync-engine-overhaul.md`)
- `metadata` → `field_definition` (definition), `field_value` (value, marked `eav_value_table: true`)
- `base` → `integration` (OAuth creds, encrypted), `pipeline`, `stage`, `record_type`

## Generated Controller Behavior

As of PR #54, generated controllers:
- Pipe `@Body()` through `ZodValidationPipe` for runtime validation (422 on failure with RFC 7807 body).
- Throw `NotFoundException` (404) from GET `:id` when the service returns null, including soft-deleted rows.
- Emit `POST` / `PATCH` / `DELETE` only when `generate.writes: true` (default).

## Layer Rules for Consumers

Aligned with codegen-patterns ADR-003 + ADR-004:

- **Repository** — single table. Extends a family base class. No business logic. Accepts optional `tx` on writes.
- **Service** — aggregate. Composes repositories. May read any repo cross-domain. May call same-domain services. **May NOT write cross-domain.** Mandatory API boundary.
- **Use Case** — workflow. Composes multiple services (including cross-domain). Owns the transaction for cross-domain writes. Emits events, calls external ports.
- **Controller** — thin adapter. Calls use cases only.

**EAV dual-write** (per ADR-13 revised): use case composes `EntityService + FieldValueService` inside `db.transaction`. Services stay single-domain; the transactional coordinator is the use case.

## Common Workflows

### Add a new entity
1. Create `entities/<name>.yaml`
2. `codegen entity new entities/<name>.yaml`
3. Barrels auto-update — no manual wiring

### Opt an entity into EAV custom fields
1. Set `eav: true` at the top level of the entity YAML
2. Ensure your project has an EAV value table (entity marked `eav_value_table: true` + `eav_definition_table: '<definition_entity>'`)
3. Regenerate — paired reads + compound-write use cases ship automatically

### Add filtered search with pagination
1. Add `queries: - name: search, filters: [...], search: <column>, paginate: true` to entity YAML
2. Regenerate — `SearchXUseCase` + `GET /xs/search` land automatically

### Add infrastructure
1. `codegen subsystem install events`
2. Register: `EventsModule.forRoot({ backend: 'drizzle' })` in app.module.ts
3. Inject: `@Inject(EVENT_BUS) private eventBus: IEventBus`

### Initialize a new project
1. `codegen init --yes` → scaffolds shared layer (base classes, tokens, Zod pipe, eav-helpers)
2. `bun add @nestjs/common @nestjs/core drizzle-orm reflect-metadata zod`
3. Create entity YAMLs, run `codegen entity new --all`

### Start dev environment
1. `codegen dev up` (requires Docker)
2. App on `localhost:3000`, check with `codegen dev status`

## Recent Upstream Changes

- **PR #52** — `generate.writes` flag emits create/update/delete use cases + POST/PATCH/DELETE routes
- **PR #53** — `eav: true` flag emits paired reads + transactional compound-write use cases; templates consume `FieldValueService.upsertFieldsTransactional`
- **PR #54** — filter query generation (`queries: { filters, search, paginate }`), `ZodValidationPipe` runtime validation, 404 on GET after soft-delete
- **PR #55** — slim consumer contract: tx-aware base classes + `ZodValidationPipe` + `eav-helpers` land via `codegen init`; `eav_value_table: true` flag emits EAV compound methods directly into the generated service/repo
