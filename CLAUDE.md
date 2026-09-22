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

## Active project

**Relations v2 + semantic model** (tracker #578). Before planning, specifying, implementing or reviewing anything that
touches relationships, repositories/services, tenant scoping, the `analytics:` block, patterns/capabilities, the
frontend emitter's relations, or the Drizzle version: read the charter at
`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`. Its §4 invariants bind every PR, and its §9 protocol says
what to update (spec, epic issue, project issue) when work lands. Remove this section when #578 closes.

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
just test-smoke-frontend             # Frontend smoke: generate.frontend + real npm install + typecheck the emitted tree
just test-all                        # typecheck + unit + baseline + 7 smokes + junction + integration-emit (CI)
just test-integration                # Scaffold integration suite (Docker + codegen + NestJS + CRUD) — own CI job

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

### Frontend Relation Graph (`src/emitters/frontend/graph-model.ts` + `emit-graph.ts`, FE-REL)

The client half of ADR-044 §5's "both sides project from the same declared graph". It calls **REL-1's own**
`buildRelationGraph` a second time and projects its edges onto the browser's collections — there is no second
traversal of the YAML (charter I1), and `test/frontend-graph-golden/` asserts the two edge-for-edge.

Emitted into `<frontendGenerated>/graph/`: `descriptor.ts` (the `graph` const, keyed by `entity.plural` with the YAML
relationship names camelCased — the same keys `relations.ts` uses), one `<entity>.ts` per `electric` entity with
edges (`<Entity>Include`, `<Entity>Graph<I>`, `use<Entity>Graph(id, include)`), and `index.ts`. A junction gets a
**collection** (electric-only, composite `getKey`, consumer-owned row type) so a `through` hop has link rows to join.

Four rules, each with a test that names it:
- **one live query per to-many relation of the root**, never one per row; a branch that was not included returns
  `undefined` from its query function and does not run (charter I4);
- an **`electric` root reaching a non-`electric` target is a generation error** that fails the command, naming both
  entities and the relation;
- an **`api` root is a deferral, not an error** — its edges stay in the descriptor, its accessors wait for REL-2's
  include allowlist, and the deferral is printed by the CLI *and* written into the descriptor;
- **junction rows are not traversal roots** (no store entry); they are reached as a to-many hop from either parent,
  and REL-1's junction-rooted edges are dropped with a warning.

Include depth is 2 (a to-one of a branch target joins into that branch's query). See docs/specs/FE-REL.md.

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
- **Integration tests**: `just test-family` / `just test-integration` — real Postgres via Docker. `test-integration` generates the scaffold consumer into the **repo root** (the scaffold's `@gen/*` alias maps there) and runs the 7 scaffold test files against it; it is **not** in `test-all` (which stays Docker-free) and has its own CI job. It requires `just install` and nothing else — the scaffold fixture declares no dependencies of its own, on purpose: two physical copies of a package break `instanceof` across the boundary (a duplicate `drizzle-orm` broke table construction; a duplicate `@nestjs/common` turned every `NotFoundException` into a 500).
- **Smoke test**: `just test-smoke` — end-to-end scaffold + generate + typecheck on a fresh tmp project (~60-120s)
- **Frontend smoke**: `just test-smoke-frontend` — the only gate that compiles the **emitted frontend tree**, and the
  only one that checks what the emitted types *are* rather than merely that they parse:
  `test/smoke/fixtures-frontend/usage/` is consumer-shaped code compiled alongside the generated tree, in which every
  property the graph accessors promise is a real assignment and every error they promise is a real
  `@ts-expect-error`. `tsc` reports an unused `@ts-expect-error` (TS2578), so that gate cannot rot into a no-op
  (FE-REL, #589). The fixture set runs `entity new --all` **and** `junction new --all` so the junction collection and
  the `through` hop are real generator output, not a hand-written YAML.
  (`test/frontend-golden` compares bytes and cannot resolve `@repo/db/entities` or
  `@pattern-stack/frontend-patterns`). Scaffolds with `generate.frontend: true`, installs the version-pairing contract
  from live npm via the CLI's own `mergeFrontendDeps`, asserts exactly **one** `@tanstack/db` is installed, then runs
  `tsc` over the emitted tree. ~12s. The four `@tanstack/*` packages pin `@tanstack/db` exactly and release in
  lockstep, so `src/emitters/frontend/deps.ts` pins them exactly and ships an `overrides` entry — caret ranges there
  split the tree into four type identities and the emitted collections stop compiling (FE-0, #620,
  `docs/specs/FE-0.md`). The consumer-owned `@repo/db/entities/*` and `@/lib/collections/auth` modules come from
  `test/smoke/fixtures-frontend/consumer/`; no template writes to either location, so they are fixtures, not stubs.
- **Smoke tsc scoping**: every smoke (`test-smoke`, `-subsystems`, `-junction`, `-frontend`, `test-smoke-integration`) fails on **any** `tsc` diagnostic located in the project it generated. The shared `test/smoke/_consumer-errors.ts` drops a diagnostic only by **location** — outside the generated project, or in `node_modules` — never by message and never by directory. It is unit-tested (`src/__tests__/smoke/consumer-errors.test.ts`); do not add a predicate to it (charter I9).
- **Tarball smoke**: `just test-post-publish` — pack all publishable packages, install into a fresh tmp project via npm, verify the consumer contract (files manifest, exports, bins, peer ranges), then re-run the smoke harness with the CLI/templates/runtime coming from the installed tarball (`SMOKE_TARBALL` mode). Gates every CI publish via `just publish-ci`. Catches the works-from-checkout-broken-from-tarball class (#190)
- **Baseline tests**: `just test-baseline` — generate from `test/fixtures/` into repo-root `packages/api/` and compare to `test/baseline/` snapshots. Two-pass generation (first pass seeds `packages/api/src/domain/*.entity.ts` files so second-pass `targetExists` checks resolve cross-entity references). Start from pristine state — the runner wipes the generated directories on each run.
- **CI** (`.github/workflows/ci.yml`), on every PR to `main` and every push to `main`:
  - job `test-all` → `just test-all` = `typecheck` + `test-unit` + `test-baseline` + `test-smoke` + `test-smoke-subsystems` + `test-smoke-relationship` + `test-smoke-junction` + `test-smoke-junction-cross-domain` + `test-smoke-frontend` + `test-junction` + `test-integration-emit` + `test-smoke-integration`
  - job `test-integration` → `just test-integration` (needs Docker, hence its own job)
  - `publish` requires both.
- **Adding a gate:** put it in `just test-all`, or give it a CI job. A gate that runs nowhere in CI rots — all three gates in #599 were red on `main` for exactly that reason.
- **Parallel worktrees:** harness state is per-checkout by derivation — the scaffold's Compose project, its Postgres port and the Hygen `bunx` cache all come from `test/scaffold/harness-env.ts` / `hygenCacheDir()` and need no env var. Run `just db-env` to see this checkout's values. Overrides are scaffold-specific — `SCAFFOLD_COMPOSE_PROJECT`, `SCAFFOLD_PG_PORT`, `SCAFFOLD_DATABASE_URL` — and an ambient `COMPOSE_PROJECT_NAME` / `DATABASE_URL` is deliberately ignored, so another stack's exports can never aim the harness's `down -v` or `TRUNCATE` at that stack. The `db-*` recipes fail closed: an invalid override stops the recipe before any `docker` call. Never name harness state with a fixed global string: sibling agents run gates concurrently, and a shared name means one run's `docker compose down -v` destroys another's database.
- **241+ total tests**, all passing

#### Known-red gates

Gates that are red on `main` today, on purpose recorded here rather than hidden, filtered or quietly dropped
(charter I9). Do not add one to CI, and do not "fix" it by loosening its assertions.

| Gate | Status | Tracking |
|---|---|---|
| `just test-smoke-junction-clean` | Red, and now reports its real number: **118** errors (110 × TS2307 unresolved module + 8 × TS7006). GATE-1 measured 120 raw behind a filter that reported 21; DRZ-2 deleted the filter (#576) and fixed 2 of the 120 (the vendored events siblings, #575). Only ~15 are the junction pipeline; the rest are the `clean` entity pipeline's missing `domain/` + `constants/` barrels, DTO `schemas` barrel, `database.module`, `zod-validation.pipe`, the generated schema barrel's singular/plural filename mismatch, and the `@repo/db/server/schema` location contract. The `clean` backend pipeline has never been typechecked anywhere — the baseline gate compiles `packages/api/src/domain/**/*` only. | **#602** (diagnosis in `docs/specs/GATE-1.md` §Failure 2); deferred by charter §5 non-goals |

**Named expectations inside green gates** — each one exact file, exact error code, issue number, asserted present
*and* sole, so it fails the moment the defect is fixed and must then be deleted:

| Gate | Expectation | Tracking |
|---|---|---|
| `just test-smoke-capability` (package leg only) | `applyIssue624Expectation`: the repository + service of each of the fixture set's two generated junctions (`meeting_contact`, CAP-2; `crew_person`, NAME-0) — 16 diagnostics per junction enumerated by file, code and named symbol with exact counts (7 × TS2307 for 5 package-owned `@shared/*` runtime modules, 4 × TS4112, 5 × TS2339), compared as a multiset both ways. `junction new` / `relationship new` hardcode `@shared/*` and do not compile under `runtime: package`; every junction harness pins vendored, so nothing saw it until CAP-2 generated a junction in both modes. | **#624** |

That is the whole list. No gate anywhere filters an error class or carves out a directory: every smoke scopes its
`tsc` output through `test/smoke/_consumer-errors.ts`, by the diagnostic's **location** only (GATE-2, #604). If a
future error genuinely cannot be fixed in the PR that surfaces it, give it a **named single-purpose expectation** —
exact file, exact error code, the issue number in a comment, asserted present *and* sole — never a predicate in that
helper and never a directory carve-out.

### Template System

Templates use Hygen. Two types:
- Regular templates (e.g., `entity.ejs.t`) create new files
- Inject templates (prefixed `_inject-`) modify existing files

Entry point: `templates/entity/new/prompt.js`. Clean-Lite-PS extends via `prompt-extension.js`.

Cross-entity names in the hygen prompts (a `belongs_to` / `has_many` / field `foreign_key:` target, an EAV
definition entity, a junction endpoint, a group Actor's members) come from `templates/_shared/entity-naming.mjs`:
`projectEntityLookup(cwd)` reads the target's own YAML (the entities-dir rule is the CLI's, `src/config/entities-dir.ts`), `entityModuleNaming` turns it into the
table export + module folder (`plural:`, `context:`), `relativeModuleDir` into the import path. Never
`pluralize(target)` or a hand-built `'../<plural>/'` (NAME-0, `docs/specs/NAME-0.md`).
