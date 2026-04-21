# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Entity-driven code generation system for full-stack TypeScript applications (v0.2). Generates Clean Architecture scaffolding from YAML entity definitions, including domain entities, repositories, use cases, DTOs, Drizzle schemas, NestJS modules, controllers, and frontend collections. Also provides infrastructure subsystem scaffolding (events, jobs, cache, storage, auth).

## Operating Principles

**No backwards compatibility until we have users.** This project has no external consumers. Architectural correctness is the only criterion. Do not preserve old tables, old commands, old config keys, old doc anchors, old import paths, or old behaviors to "avoid breaking things." Replace them cleanly. Iterative snapshots are disposable. If a decision is being made on backwards-compat grounds, the decision is wrong — re-evaluate from architectural correctness alone.

This applies to every ADR, spec, and code change. Agents that find themselves writing "deprecated" callouts, upgrade commands, parallel-old-and-new schemas, or migration shims should stop and ask whether the predecessor exists for any reason other than backwards compat. If not, delete it.

**Backend swappability via core/extension protocols.** Subsystems that allow swappable backends (events, jobs, cache, storage, etc.) must structure their protocols as a **core contract + opt-in extensions**:

- **Core contract** — every backend MUST implement. Defines the minimum capability surface guaranteed across all backends. App code written against the core is portable.
- **Extensions** — backends MAY add features beyond the core (e.g., BullMQ backend exposing Bull Board mounting; Postgres backend exposing `LISTEN/NOTIFY`). Consumers opting into extensions accept backend-specific code paths.

Avoid the "uniform interface that hides everything" trap (e.g., ORMs that pretend all databases are equivalent). The core contract guarantees portability for the 90% case; extensions let consumers leverage their chosen backend's actual strengths. Collapse abstraction layers that exist purely to preserve uniformity at the cost of feature access.

**Specs and skills are living documentation — update as you work.** ADRs, specs (`docs/specs/*`), and skills (`.claude/skills/*`) describe intent at the moment they were written. Implementation always discovers things that intent missed: a clearer name, a missing edge case, a constraint the spec assumed away, an open question that turned out to have an obvious answer. When you discover any of these while working, **update the spec or skill in the same PR as the code change**. Do not "leave it for later." Do not "ask the original author." The agent doing the work has the freshest context to fix the documentation; the agent reading it next has no recourse if it is wrong.

Concretely:
- Implementing a JOB-N spec? When you finish, the spec should reflect what was actually built — close any open questions you resolved, correct any details that turned out wrong, add any constraints discovered during implementation. The spec becomes the post-implementation truth, not just the pre-implementation plan.
- Working in a domain skill? When you find a routing table that doesn't match reality, a "do not" rule that's too vague, or a missing L1 file for a topic that came up — fix it. Skills are living documentation, not snapshots.
- Touching an ADR's territory? If a decision was made on grounds that no longer apply (e.g., backwards compat we agreed to drop, an alternative we now want to revisit), add a dated revision note. Don't silently ignore the ADR.

The cost of stale documentation compounds: every future agent reading it pays for the drift. The cost of updating it as you go is one extra paragraph per PR. Pay the small cost.

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
- **`templates/entity/new/clean-lite-ps/`** — Clean-Lite-PS: lighter layout with entity, service, repository, controller, module, DTOs, use-cases. Selected via `generate.architecture: clean-lite-ps`. Has its own `prompt-extension.js`. The two backend template pipelines are mutually exclusive — `generate.architecture` picks exactly one.

### Project Layout

```
src/                    # Generator source code
  cli/                  # Clipanion CLI (noun-verb: entity, subsystem, project)
  index.ts              # Package exports
  analyzer/             # Graph building, consistency checking, suggestions
  behaviors/            # Shared behaviors (timestamps, soft-delete, user-tracking)
  config/               # Config loader, paths, locations, naming
  formatters/           # Console, JSON, markdown output formatters
  parser/               # YAML loading, cross-reference resolution
  scanner/              # Project pattern detection (framework, ORM, naming)
  schema/               # Zod schemas for entity definitions
  utils/                # YAML and config loaders
  __tests__/            # Unit tests (mirrors src/ structure)
runtime/                # Code shipped into user's generated project
  base-classes/         # BaseRepository, BaseService, family repos/services, WithAnalytics
  subsystems/           # Infrastructure: events, jobs, cache, storage, auth
  constants/            # Injection tokens
  types/                # DrizzleClient type
templates/              # Hygen EJS templates (the core product)
test/                   # Cross-cutting: baseline snapshots, fixtures, scaffold integration
docs/                   # ADRs
```

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

Base classes in `runtime/base-classes/`:

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
