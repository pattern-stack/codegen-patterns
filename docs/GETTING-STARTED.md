# Getting Started

Generate Clean Architecture scaffolding for TypeScript/NestJS apps from YAML entity definitions.

## Prerequisites

- [mise](https://mise.jdx.dev) — runtime version manager (installs bun + node)
- [just](https://just.systems) — command runner
- Docker — required only for integration tests (Postgres)

## Installation

```bash
git clone <repo-url> && cd codegen-patterns
mise install        # install pinned bun + node versions
just install        # install all dependencies
```

## Create Your First Entity

Create `entities/task.yaml`:

```yaml
entity:
  name: task
  plural: tasks
  table: tasks
```

This is the minimum — a named entity mapping to a database table. Now add fields:

```yaml
fields:
  title:
    type: string
    required: true
    max_length: 255
  description:
    type: string
    nullable: true
  status:
    type: enum
    choices: [todo, in_progress, done]
    required: true
  priority:
    type: integer
    nullable: true
  assignee_id:
    type: uuid
    foreign_key: users.id
    index: true
  due_date:
    type: date
    nullable: true
```

Field types: `string`, `integer`, `decimal`, `boolean`, `uuid`, `date`, `datetime`, `json`, `enum`. YAML fields use `snake_case` — the codegen derives `camelCase` TypeScript properties automatically.

Add behaviors for common columns:

```yaml
behaviors:
  - timestamps       # createdAt, updatedAt
  - soft_delete      # deletedAt + query filtering
```

Define relationships:

```yaml
relationships:
  assignee:
    type: belongs_to
    target: user
    foreign_key: assignee_id
```

Relationship types: `belongs_to`, `has_many`, `has_one`.

Add declarative queries:

```yaml
queries:
  - by: [assignee_id]
  - by: [status]
    order: due_date asc
  - by: [assignee_id, status]
```

Each entry generates a typed repository method. `by: [assignee_id]` produces `findByAssigneeId()`. Add `unique: true` for single-result queries.

## Generate Code

```bash
just gen entities/task.yaml
```

This produces Clean Architecture output under your configured `backend_src`:

```
domain/task/              # Entity class + repository interface
application/
  commands/task/          # CreateTask, UpdateTask, DeleteTask
  queries/task/           # GetTaskById, ListTasks, + declarative queries
  schemas/                # Zod DTOs
infrastructure/
  persistence/drizzle/    # Drizzle schema
  persistence/repositories/  # Repository implementation
presentation/rest/        # REST controller
modules/                  # NestJS module wiring
```

Generate all entities at once with `just gen-all`.

## Add Infrastructure Subsystems

Scaffold production-ready infrastructure backed by Postgres (no Redis required):

```bash
just gen-subsystem events    # Domain event bus (transactional outbox)
just gen-subsystem jobs      # Background job queue (pg-boss pattern)
```

Each subsystem generates a protocol (interface), Drizzle backend, memory backend (for tests), and a NestJS module with `forRoot()` factory. Wire them into your app:

```typescript
// app.module.ts
@Module({
  imports: [
    DatabaseModule,
    EventsModule.forRoot({ backend: 'drizzle' }),
    JobsModule.forRoot({ backend: 'drizzle' }),
    TasksModule,
  ],
})
export class AppModule {}
```

Tests swap to memory backends — no Docker needed:

```typescript
EventsModule.forRoot({ backend: 'memory' })
```

Also available: `just gen-subsystem cache` and `just gen-subsystem storage`.

## Configure for Your Project

Auto-detect your project's conventions:

```bash
just scan
```

This scans your codebase and generates `codegen.config.yaml`. Then customize:

```yaml
paths:
  backend_src: src
  frontend_src: apps/frontend/src

generate:
  architecture: clean-lite-ps  # clean | clean-lite-ps (mutually exclusive)
  frontend: false              # Emit frontend pipeline? (default: false)
  commands: true
  queries: true

naming:
  fileCase: kebab-case       # kebab-case | PascalCase | camelCase | snake_case
  suffixStyle: dotted        # dotted (.entity.ts) | suffixed (Entity.ts)
  terminology:
    command: use-case         # command | use-case
    query: query              # query | use-case
```

Key config sections:
- **paths** — where generated backend/frontend code lands
- **generate** — toggle which outputs are produced
- **naming** — control file casing, suffix style, class naming
- **locations** — override output paths and import aliases
- **frontend.sync** — configure Electric SQL shape URLs and column mapping

## Run Tests

```bash
# Unit tests (fast, no Docker)
just test-unit

# Integration tests (needs Postgres)
just db-up              # start Docker Postgres
just db-push            # push schema
just test-family        # run family repo integration tests
just db-down            # stop Postgres when done
```

Baseline snapshot testing for template changes:

```bash
just test-baseline      # generate from fixtures + compare to baseline/
```

## Next Steps

- **Entity families** — assign `family: synced` (or `activity`, `metadata`, `knowledge`) in your YAML to inherit domain-specific query patterns. See [ADR-005](architecture/adrs/ADR-005-entity-family-base-classes.md).
- **Declarative queries** — the `queries:` block generates typed repository methods with compound filters and ordering. No hand-written SQL.
- **Subsystem architecture** — events, jobs, cache, and storage follow the Protocol/Backend/Factory pattern. See [ADR-008](architecture/adrs/ADR-008-subsystem-architecture.md).
- **Claude Code skill** — run `just install-skill /path/to/my-app` to teach Claude Code how to generate entities in your project.
- **Architecture decisions** — browse `docs/architecture/adrs/` for the full set of ADRs.
