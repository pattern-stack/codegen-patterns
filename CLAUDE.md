# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Entity-driven code generation system for full-stack TypeScript applications (v0.2). Generates Clean Architecture scaffolding from YAML entity definitions, including domain entities, repositories, use cases, DTOs, Drizzle schemas, NestJS modules, controllers, and frontend collections. Also provides infrastructure subsystem scaffolding (events, jobs, cache, storage).

## Commands

```bash
# Install
just install                      # Install all deps (root + scaffold)
mise install                      # Pin bun + node versions

# Code generation
just gen entities/opportunity.yaml   # Generate single entity
just gen-all                         # Generate all entities
just gen-subsystem events            # Scaffold a subsystem (events|jobs|cache|storage)

# Project scanning
just scan                            # Auto-detect patterns, generate config

# Domain analysis
just validate-entities               # Validate YAML files
just analyze                         # Full analysis with graph
just stats                           # Statistics only

# Testing
just test-unit                       # Unit tests (base classes + subsystems, ~200ms)
just test-family                     # Family repo integration tests (needs Docker)
just test-baseline                   # Baseline snapshot test (generate + compare)
just test-integration                # Full integration (Docker + codegen + NestJS)
just validate                        # End-to-end scaffold validation

# Database (scaffold testing)
just db-up                           # Start Postgres
just db-push                         # Push schema
just db-down                         # Stop Postgres

# Release
just bump patch                      # Bump version (patch | minor | major)
just release                         # Tag + push
```

## Architecture

### Core Pipeline
```
YAML Entity Definition → Parser → Analyzer → Hygen Templates → Generated Code
```

### Two Template Pipelines

- **`templates/entity/new/backend/`** + **`frontend/`** — Full Clean Architecture: separate command/query classes, repository interfaces, NestJS modules.
- **`templates/entity/new/clean-lite-ps/`** — Clean-Lite-PS: lighter layout with entity, service, repository, controller, module, DTOs, use-cases. Enabled via `generate.cleanLitePs: true`. Has its own `prompt-extension.js`.

### Module Structure

| Directory | Purpose |
|-----------|---------|
| `cli.ts` | CLI entry point with all command handlers |
| `parser/` | YAML loading, cross-reference resolution |
| `analyzer/` | Graph building, consistency checking, suggestions |
| `scanner/` | Project pattern detection (framework, ORM, naming) |
| `schema/` | Zod schemas for entity definitions |
| `behaviors/` | Shared behaviors (timestamps, soft-delete, user-tracking) |
| `config/` | Config loader, paths, locations, naming |
| `output/` | Console, JSON, markdown formatters |
| `templates/` | Hygen EJS templates (the core product) |
| `shared/base-classes/` | BaseRepository, BaseService, family repos/services, WithAnalytics |
| `shared/subsystems/` | Infrastructure: events, jobs, cache, storage (Protocol → Backend → Factory) |
| `shared/constants/` | Injection tokens |
| `shared/types/` | DrizzleClient type |
| `utils/` | YAML and config loaders used by CLI |
| `test/` | Baseline snapshots, fixtures, scaffold integration |
| `docs/` | ADRs and architecture docs |

### Infrastructure Subsystems (ADR-008)

Four subsystems following Protocol → Backend → Factory pattern:

| Subsystem | Protocol | Default Backend | Test Backend |
|-----------|----------|----------------|--------------|
| Events | `IEventBus` | Drizzle (outbox) | Memory |
| Jobs | `IJobQueue` | Drizzle (pg-boss) | Memory |
| Cache | `ICacheService` | Drizzle (TTL) | Memory |
| Storage | `IStorageService` | Local filesystem | Memory |

All use `DynamicModule.forRoot({ backend })` with `global: true`.

### Entity Families

Base classes in `shared/base-classes/`:

| Family | Repository | Service |
|--------|-----------|---------|
| `synced` | SyncedEntityRepository | SyncedEntityService |
| `activity` | ActivityEntityRepository | ActivityEntityService |
| `metadata` | MetadataEntityRepository | MetadataEntityService |
| `knowledge` | KnowledgeEntityRepository (stub) | KnowledgeEntityService (stub) |
| *(base)* | BaseRepository | BaseService |

### Declarative Queries

`queries:` block in entity YAML generates typed repository methods, interface signatures, injectable query classes, and NestJS module registration:

```yaml
queries:
  - by: [user_id]              # → findByUserId()
  - by: [email]                # → findByEmail() (unique)
    unique: true
  - by: [account_id]           # → findByAccountId() (ordered)
    order: created_at desc
  - by: [user_id, account_id]  # → findByUserIdAndAccountId()
```

## Key Patterns

### Naming Conventions
- YAML fields: `snake_case` (matches database columns)
- TypeScript properties: `camelCase` (derived from snake_case in templates)
- Entity names in YAML: singular snake_case (`opportunity`)

### Configuration

Project config in `codegen.config.yaml`. Key sections: `paths`, `locations`, `generate`, `naming`, `frontend`. See README.md for full reference.

Auto-detect: `just scan` generates a config from project conventions.

### Testing

- **Unit tests**: `just test-unit` — base classes, subsystems, scanner, schema (~200ms)
- **Integration tests**: `just test-family` / `just test-integration` — real Postgres via Docker
- **Baseline tests**: `just test-baseline` — generate + compare to snapshots
- **241 total tests**, all passing

### Template System

Templates use Hygen. Two types:
- Regular templates (e.g., `entity.ejs.t`) create new files
- Inject templates (prefixed `_inject-`) modify existing files

Entry point: `templates/entity/new/prompt.js`. Clean-Lite-PS extends via `prompt-extension.js`.
