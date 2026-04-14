# codegen-patterns

Entity-driven code generation for full-stack TypeScript apps. Define entities in YAML, generate Clean Architecture scaffolding — domain entities, repositories, use cases, DTOs, Drizzle schemas, NestJS modules, controllers, and frontend collections.

## Setup

```bash
bun install
```

Requires [mise](https://mise.jdx.dev) for runtime management and [just](https://just.systems) for task running:

```bash
mise install        # install pinned bun + node versions
just install        # install all deps (root + scaffold)
```

> **Using codegen in your own project?** See [**docs/CONSUMER-SETUP.md**](docs/CONSUMER-SETUP.md) for the consumer contract — required tsconfig path aliases, `DatabaseModule` scaffold, and `@shared/*` re-export shims. [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) covers entity YAML authoring.

## Quick Start

```bash
# Define an entity
cat > entities/contact.yaml << 'YAML'
entity:
  name: contact
  plural: contacts
  table: contacts

fields:
  email:
    type: string
    required: true
    max_length: 255
  first_name:
    type: string
    required: true
  account_id:
    type: uuid
    foreign_key: accounts.id

behaviors:
  - timestamps
  - soft_delete

relationships:
  account:
    type: belongs_to
    target: account
    foreign_key: account_id
YAML

# Generate
just gen entities/contact.yaml
```

## What Gets Generated

**Clean Architecture** (default):
```
{backend_src}/
├── domain/{entity}/           # Entity class + repository interface
├── application/
│   ├── commands/{entity}/     # Create, Update, Delete
│   ├── queries/{entity}/      # GetById, List, + declarative queries
│   └── schemas/               # Zod DTOs
├── infrastructure/persistence/
│   ├── drizzle/               # Drizzle schema
│   └── repositories/          # Repository implementation
├── presentation/rest/         # REST controller
└── modules/                   # NestJS module wiring
```

**Clean-Lite-PS** (`generate.architecture: clean-lite-ps`):
```
modules/{plural}/
├── {entity}.entity.ts         # Drizzle table + types
├── {entity}.repository.ts     # Extends family base class
├── {entity}.service.ts        # Extends family base service
├── {entity}.controller.ts     # REST endpoints
├── {plural}.module.ts         # NestJS module
├── dto/                       # Create, Update, Output DTOs
├── use-cases/                 # FindById, List
└── index.ts                   # Barrel export
```

## Entity YAML Schema

```yaml
entity:
  name: contact                     # singular snake_case
  plural: contacts                  # plural form
  table: contacts                   # database table name
  folder_structure: nested          # nested | flat
  family: synced               # optional: synced | activity | metadata | knowledge

fields:
  email:
    type: string                    # string | integer | decimal | boolean | uuid | date | datetime | json | enum
    required: true
    max_length: 255
    index: true
  status:
    type: enum
    choices: [active, inactive]

behaviors:
  - timestamps                      # createdAt, updatedAt
  - soft_delete                     # deletedAt + query filtering
  - user_tracking                   # createdBy, updatedBy

relationships:
  account:
    type: belongs_to                # belongs_to | has_many | has_one
    target: account
    foreign_key: account_id

queries:                            # Declarative query generation
  - by: [user_id]                   # → findByUserId(): Promise<Contact[]>
  - by: [email]                     # → findByEmail(): Promise<Contact | null>
    unique: true
  - by: [account_id]               # → findByAccountId(): ordered
    order: created_at desc
  - by: [user_id, account_id]      # → compound WHERE
```

## Entity Families

Families provide pre-built base classes with domain-specific query patterns:

| Family | Use Case | Inherited Methods |
|--------|----------|-------------------|
| `synced` | Synced entities (contacts, accounts) | `findByExternalId`, `findAllByUserId`, `syncUpsert` |
| `activity` | Time-based events (emails, calls) | `findByDateRange`, `findByUserId`, `findRecentByOpportunityId` |
| `metadata` | Key-value data (field values, tags) | `findByEntityIdAndType`, `listByEntityId`, `upsertMany` |
| `knowledge` | Vector-searchable content | Stub (needs pgvector) |
| *(none)* | Generic entities | Base CRUD only |

## Infrastructure Subsystems

Scaffold production-ready infrastructure with Postgres-backed defaults (ADR-008):

```bash
just gen-subsystem events          # Domain event bus (transactional outbox)
just gen-subsystem jobs            # Background job queue (pg-boss pattern)
just gen-subsystem cache           # Key-value cache with TTL
just gen-subsystem storage         # File storage (local filesystem)
```

Each subsystem generates a **protocol** (interface), **Drizzle backend** (Postgres), **memory backend** (tests), and a **NestJS module** with `forRoot()` factory:

```typescript
// app.module.ts
@Module({
  imports: [
    DatabaseModule,
    EventsModule.forRoot({ backend: 'drizzle' }),
    JobsModule.forRoot({ backend: 'drizzle' }),
    CacheModule.forRoot({ backend: 'drizzle', defaultTtl: 300 }),
    StorageModule.forRoot({ backend: 'local' }),
  ],
})
export class AppModule {}

// Tests swap to memory — no Docker needed
EventsModule.forRoot({ backend: 'memory' })
```

Use cases inject subsystem protocols via tokens (`EVENT_BUS`, `JOB_QUEUE`, `CACHE`, `STORAGE`). Services cannot import subsystem tokens — this mechanically enforces the ADR-003 sharp test.

## Configuration

Create `codegen.config.yaml` in your project root:

```yaml
paths:
  backend_src: src
  frontend_src: apps/frontend/src

generate:
  architecture: clean-lite-ps      # Backend layout: clean | clean-lite-ps
  frontend: false                  # Emit Electric-SQL frontend pipeline (default: false)
  commands: true                   # Generate write commands
  queries: true                    # Generate read queries

naming:
  fileCase: kebab-case             # kebab-case | PascalCase | camelCase | snake_case
  suffixStyle: dotted              # dotted (.entity.ts) | suffixed (Entity.ts)
  terminology:
    command: use-case              # command | use-case
    query: query                   # query | use-case

locations:
  backendCommands:
    path: src/applications/use-cases
    import: '@backend/applications/use-cases'
```

Auto-detect your project's conventions:

```bash
just scan                          # generates codegen.config.yaml
```

## Commands

```bash
# Dev
just gen entities/contact.yaml     # Generate single entity
just gen-all                       # Generate all entities
just gen-subsystem events          # Scaffold a subsystem
just scan                          # Auto-detect project patterns

# Test
just test-unit                     # Unit tests (base classes, ~40ms)
just test-family                   # Family repo integration tests (needs Docker)
just test-baseline                 # Baseline snapshot test (generate + compare)
just test-integration              # Full integration (Docker + codegen + NestJS)
just validate                      # End-to-end scaffold validation

# Domain Analysis
just validate-entities             # Validate YAML files
just analyze                       # Dependency graph + issues
just stats                         # Entity statistics

# Release
just bump patch                    # Bump version (patch | minor | major)
just release                       # Tag + push

# Database (scaffold)
just db-up                         # Start Postgres
just db-push                       # Push schema
just db-down                       # Stop Postgres
```

## Claude Code Skill

Install the codegen skill into your project to teach Claude how to use it:

```bash
just install-skill /path/to/my-app
```

This copies a skill definition to `.claude/skills/codegen/` that Claude Code auto-detects when you ask it to create entities, scaffold modules, or add API endpoints.

## Architecture

```
YAML Entity Definition → Parser → Analyzer → Hygen Templates → Generated Code
```

| Directory | Purpose |
|-----------|---------|
| `src/cli/` | Clipanion CLI (noun-verb: entity, subsystem, project) |
| `src/parser/` | YAML loading and cross-reference resolution |
| `src/analyzer/` | Graph building, consistency checking, suggestions |
| `src/scanner/` | Project pattern detection |
| `src/schema/` | Zod validation schemas |
| `src/behaviors/` | Shared entity behaviors (timestamps, soft delete) |
| `src/config/` | Config loader, paths, locations, naming |
| `src/formatters/` | Console, JSON, markdown output formatters |
| `src/__tests__/` | Unit tests (mirrors `src/` structure) |
| `runtime/base-classes/` | BaseRepository, BaseService, family repos/services, WithAnalytics |
| `runtime/subsystems/` | Events, Jobs, Cache, Storage (Protocol → Backend → Factory) |
| `templates/` | Hygen EJS templates (the core product) |
| `test/` | Baseline snapshots, fixtures, scaffold integration |
| `docs/adrs/` | Architecture decision records |

## License

MIT
