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
just test-smoke                      # End-to-end smoke: scaffold + generate + typecheck fresh project (~60-120s)
just test-all                        # test-unit + test-baseline + test-smoke (run on every PR to main via CI)
just test-integration                # Full integration (Docker + codegen + NestJS)
just validate                        # End-to-end scaffold validation

# Database (scaffold testing)
just db-up                           # Start Postgres
just db-push                         # Push schema
just db-down                         # Stop Postgres

# Release — merging a version bump to main publishes automatically (CI `publish`
# job: tarball smoke gate + publish-if-version-not-on-npm, per package).
just bump patch                      # Bump version (patch | minor | major)
just test-post-publish               # Tarball smoke: pack + install + verify consumer contract
just publish-ci --dry-run            # Validate the full publish without uploading
just publish                         # Manual fallback: publish origin/main from a pristine worktree
```

## Architecture

### Core Pipeline
```
YAML Entity Definition → Parser → Analyzer → Hygen Templates / TS Emitters → Generated Code
```

The backend uses **hygen templates**; the frontend and integration layers use
**TypeScript emitters** (`src/emitters/`). Both consume the same parsed entity set.

### Backend Template Pipelines (hygen)

- **`templates/entity/new/backend/`** — Full Clean Architecture: separate command/query classes, repository interfaces, NestJS modules. Selected via `generate.architecture: clean` (default).
- **`templates/entity/new/clean-lite-ps/`** — Clean-Lite-PS: lighter layout with entity, service, repository, controller, module, DTOs, use-cases. Selected via `generate.architecture: clean-lite-ps`. Has its own `prompt-extension.js`. The two backend template pipelines are mutually exclusive — `generate.architecture` picks exactly one.

### Frontend Emitter (`src/emitters/frontend/`, ADR-038)

The frontend pipeline is a **whole-set TypeScript emitter**, not hygen templates
(`templates/entity/new/frontend/` was deleted). Gated by `generate.frontend`
(default false), it runs as the `entity new` post-step and renders the complete
frontend tree — per-entity AND cross-entity files (`store/`, barrels, `config.ts`,
`query-client.ts`) — from the full entity set in one pass, idempotently
(complete-file writes, `@generated` banner, no inject/anchor machinery). Hook /
mutation / store logic is consumed from `@pattern-stack/frontend-patterns`
(`createEntityHooks` / `createStore`); generated files are thin wiring. FK target
names resolve against the cross-entity registry (the target's own YAML), never
re-pluralized at emit time. Per-entity `sync: api | electric` overrides the global
`frontend.sync.mode`. The `frontend:` Zod block lives in
`src/schema/codegen-config.schema.ts`; the entry point is `emitFrontendSet`
(`src/emitters/frontend/index.ts`), wired via `loadFrontendEmitContext`. See
docs/specs/2026-06-04-frontend-pipeline-rebuild.md.

### Project Layout

```
src/                    # Generator source code
  cli/                  # Clipanion CLI (noun-verb: entity, subsystem, project)
  emitters/             # TS emitters: frontend (ADR-038), integration (RFC-0001/2/3)
  index.ts              # Package exports
  analyzer/             # Graph building, consistency checking, suggestions
  behaviors/            # Shared behaviors (timestamps, soft-delete, user-tracking)
  config/               # Config loader, paths, locations, naming
  formatters/           # Console, JSON, markdown output formatters
  parser/               # YAML loading, cross-reference resolution (+ entity registry)
  scanner/              # Project pattern detection (framework, ORM, naming)
  schema/               # Zod schemas for entity definitions + codegen config
  utils/                # YAML and config loaders
  __tests__/            # Unit tests (mirrors src/ structure)
runtime/                # Code shipped into user's generated project
  base-classes/         # BaseRepository, BaseService, family repos/services, WithAnalytics
  subsystems/           # Infrastructure: events, jobs, cache, storage, auth
  constants/            # Injection tokens
  types/                # DrizzleClient type
templates/              # Hygen EJS templates (backend pipelines)
test/                   # Cross-cutting: baseline snapshots, fixtures, scaffold integration
docs/                   # ADRs
```

### Infrastructure Subsystems (ADR-008)

Five subsystems following Protocol → Backend → Factory pattern:

| Subsystem | Protocol | Default Backend | Test Backend |
|-----------|----------|----------------|--------------|
| Events | `IEventBus` | Drizzle (outbox) | Memory |
| Jobs | `IJobQueue` | Drizzle (pg-boss) | Memory |
| Cache | `ICacheService` | Drizzle (TTL) | Memory |
| Storage | `IStorageService` | Local filesystem | Memory |
| Observability | `IObservabilityService` | Drizzle (read-only facade) | Memory |

All use `DynamicModule.forRoot({ backend })` with `global: true`.

### Integration Codegen (RFC-0001/0002/0003)

For entities tagged with `surface:` (when `definitions/providers/*.yaml` exist), the `entity new` post-step emits the **full** integration layer per `(surface, provider, entity)`, not just the read side:

- **Read side** (RFC-0001) — provider module (auth + client), adapter scaffold whose `changeSources: Record<string, IChangeSource<unknown>>` the adapter *contributes* (keyed by entity), the surface aggregator that folds those into the `<SURFACE>_ENTITY_SOURCES` registry, and typed views. The adapter holds the contributions; the folded registry is the surface module's concern (post-E0 — the adapter no longer injects the registry).
- **Read primitive** (RFC-0003) — for interaction surfaces (mail/calendar/transcript), each `changeSources` entry is emitted as an emit-once `IncrementalReadBase<Canonical<Entity>, ResolvedFilter[]>` subclass (the enumerate/hydrate read-body scaffold). The base owns streaming, filter-before-hydrate, bounded-concurrency hydration, and per-ref cursor emission; the author fills only `enumerate` / `hydrate` / `toCanonical`. Lives in `runtime/subsystems/integration/`, exported from `@pattern-stack/codegen/subsystems`.
- **Module assembly** (RFC-0002) — the write/run side: per-entity `<entity>-integration.module.ts` binding `INTEGRATION_CHANGE_SOURCE` (= `adapter.changeSources['<entity>']`) + `INTEGRATION_SINK` + a local `ExecuteIntegrationUseCase` exported under a unique `<ENTITY>_INTEGRATION_USE_CASE__<PROVIDER>` token; a seam-split default sink (`pattern: Integrated` only): a regenerated `@generated <entity>.sink.generated.ts` base (standalone default fns + abstract Shape C seams) plus an emit-once `<entity>.sink.ts` author subclass; a surface integration aggregator; and a tokens file.

The author seam is just the vendor read methods plus any non-generic sink write logic.

### Entity Families

Base classes in `runtime/base-classes/`:

| Family | Repository | Service |
|--------|-----------|---------|
| `integrated` | IntegratedEntityRepository | IntegratedEntityService |
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
- **Smoke test**: `just test-smoke` — end-to-end scaffold + generate + typecheck on a fresh tmp project (~60-120s)
- **Tarball smoke**: `just test-post-publish` — pack all publishable packages, install into a fresh tmp project via npm, verify the consumer contract (files manifest, exports, bins, peer ranges), then re-run the smoke harness with the CLI/templates/runtime coming from the installed tarball (`SMOKE_TARBALL` mode). Gates every CI publish via `just publish-ci`. Catches the works-from-checkout-broken-from-tarball class (#190)
- **Baseline tests**: `just test-baseline` — generate from `test/fixtures/` into repo-root `packages/api/` and compare to `test/baseline/` snapshots. Two-pass generation (first pass seeds `packages/api/src/domain/*.entity.ts` files so second-pass `targetExists` checks resolve cross-entity references). Start from pristine state — the runner wipes the generated directories on each run.
- **CI**: `just test-all` (unit + baseline + smoke) runs on every PR to `main` and every push to `main` (`.github/workflows/ci.yml`)
- **241+ total tests**, all passing

### Template System

Templates use Hygen. Two types:
- Regular templates (e.g., `entity.ejs.t`) create new files
- Inject templates (prefixed `_inject-`) modify existing files

Entry point: `templates/entity/new/prompt.js`. Clean-Lite-PS extends via `prompt-extension.js`.
