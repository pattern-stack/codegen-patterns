# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Entity-driven code generation system for full-stack TypeScript applications (v0.2). Generates one NestJS module folder per entity (backend) from YAML entity definitions — Drizzle table, repository, service, controller, module, DTOs, use cases — plus frontend collections. Also provides infrastructure subsystem scaffolding (events, jobs, cache, storage, auth).

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

### Backend Template Pipeline (hygen)

- **`templates/entity/new/backend/`** — the one backend pipeline: per entity, a module folder under `paths.modules_dir` (`<modules_dir>[/<context>]/<plural>/`) holding the entity (Drizzle table), repository, service, controller, module, DTOs and use-cases. `backend/entity-locals.js` builds almost every local; `prompt.js` builds only the four it does not (the `@generated` banner, the runtime-import specifiers, the `detection:` literal and the EVT-7 `emits:` descriptors) and spreads the extension's over them. Every template references its locals unguarded, so a missing local throws (#638).
- There is no architecture choice. The `clean` pipeline (`templates/entity/new/backend/`) and `generate.architecture` were deleted by ARCH-0 (#677, `docs/specs/ARCH-0.md`); writing the key is an unknown-key error. ARCH-1 (#682, `docs/specs/ARCH-1.md`) deleted the rest of the surface only `clean` read — `naming:`, `database:`, `behaviors:`, the 14 `locations.backend*` names (plus four dead `db*` ones), the entity layout keys (`folder_structure:`, `file_grouping:`, `behavior_strategy:`) and the 69 dead `prompt.js` locals behind them, with `src/config/naming-config.mjs`, `src/config/locations.mjs` and `src/schema/naming-config.schema.ts`. Each deleted key is now an unknown-key error naming the key and the file. `expose:` stays — the frontend emitter reads it.

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
- **Baseline tests**: `just test-baseline` — generate the closed entity set in `test/fixtures/entities/` (config `test/fixtures/codegen.config.yaml`) into repo-root `packages/api/src/` — the clean-lite-ps module tree plus the two cross-entity post-steps the CLI runs (the ADR-017 `modules.ts` / `schema.ts` barrels and REL-1's `relations.ts` manifest) — typecheck it against the in-repo runtime (`test/tsconfig.baseline.json`, which maps `@shared/*` onto `runtime/` and `@gen/*` onto the generated backend root so the scaffold's `database.module.ts` resolves its manifest import), and compare to `test/baseline/` snapshots. Two-pass generation (the first pass seeds every `<entity>.entity.ts` so the second pass's `targetExists` checks resolve cross-entity imports). Start from pristine state — the runner wipes the generated directories on each run.
- **CI** (`.github/workflows/ci.yml`), on every PR to `main` and every push to `main`:
  - job `test-all` → `just test-all` = `typecheck` + `test-unit` + `test-baseline` + `test-smoke` + `test-smoke-subsystems` + `test-smoke-relationship` + `test-smoke-junction` + `test-smoke-junction-cross-domain` + `test-smoke-frontend` + `test-junction` + `test-integration-emit` + `test-smoke-integration`
  - job `test-integration` → `just test-integration` (needs Docker, hence its own job)
  - `publish` requires both.
- **Adding a gate:** put it in `just test-all`, or give it a CI job. A gate that runs nowhere in CI rots — all three gates in #599 were red on `main` for exactly that reason.
- **A gate must be able to fail on its own subject.** Running in CI is not enough — all of #726's variants *were* in CI and *were* running. Three shapes to check when you write or review one: (a) the harness file must **parse** — `test/smoke/run-smoke-junction.ts` did not, so the gate had never executed on eleven PRs and every one of those reds was read as inherited; (b) assertions must resolve through the **same configuration as the code under test** — the junction smoke looked for the relations manifest at the default `src/generated/` even on its `--layout custom` legs, so it could not have caught the hardcoded import it existed to guard; (c) an **absent input must not default to permissive** — ARCH-1 dropped `ownedTableNames` from an explicit key list and `processFieldFeatures` reads an absent set as *every target is owned*, silently reverting #636 and surfacing as an unrelated error. A gate that cannot fail on its own subject buys false confidence, which is worse than no gate.
- **Narrowing a spread to an explicit key list is a silent-drop hazard.** `{...locals, …}` → `{ a, b, c }` reads as a cleanup at both ends: the producer still computes and returns the dropped key, every local reader still looks correct, and nothing appears deleted in the diff. The failure surfaces one layer away at the consumer, and only if the consumer fails loudly on the missing value — which (c) above is exactly the case where it does not. When you narrow a spread, enumerate the consumers, not the keys.
- **Parallel worktrees:** harness state is per-checkout by derivation — the scaffold's Compose project, its Postgres port and the Hygen `bunx` cache all come from `test/scaffold/harness-env.ts` / `hygenCacheDir()` and need no env var. Run `just db-env` to see this checkout's values. Overrides are scaffold-specific — `SCAFFOLD_COMPOSE_PROJECT`, `SCAFFOLD_PG_PORT`, `SCAFFOLD_DATABASE_URL` — and an ambient `COMPOSE_PROJECT_NAME` / `DATABASE_URL` is deliberately ignored, so another stack's exports can never aim the harness's `down -v` or `TRUNCATE` at that stack. The `db-*` recipes fail closed: an invalid override stops the recipe before any `docker` call. Never name harness state with a fixed global string: sibling agents run gates concurrently, and a shared name means one run's `docker compose down -v` destroys another's database.
- **241+ total tests**, all passing

#### Known-red gates

Gates that are red on `main` today, on purpose recorded here rather than hidden, filtered or quietly dropped
(charter I9). Do not add one to CI, and do not "fix" it by loosening its assertions.

None today. ARCH-0 (#677) deleted the last one, `just test-smoke-junction-clean`, together with the `clean`
pipeline it exercised (#602 closed as obsolete).

**Named expectations inside green gates** — each one exact file, exact error code, issue number, asserted present
*and* sole, so it fails the moment the defect is fixed and must then be deleted:

| Gate | File | Codes | Issue |
|---|---|---|---|
| `just test-baseline` (typecheck step, `ISSUE_680_EXPECTATION` in `test/run-test.ts`) | `packages/api/src/modules/contacts/contact.repository.ts` | TS7053 ×2, TS2322 ×1 — the `via:` / `select:` declarative queries on `contact-v2.yaml` | **#680** |

No gate anywhere filters an error class or carves out a directory: every smoke scopes its
`tsc` output through `test/smoke/_consumer-errors.ts`, by the diagnostic's **location** only (GATE-2, #604). If a
future error genuinely cannot be fixed in the PR that surfaces it, give it a **named single-purpose expectation** —
exact file, exact error code, the issue number in a comment, asserted present *and* sole — never a predicate in that
helper and never a directory carve-out.

### Template System

Templates use Hygen. Every template writes a complete file (`force: true`, or emit-once); there are no inject
templates. A file two generators contribute to is rendered by its owner from both inputs — e.g. a junction's fan-out
onto its parents is rendered by the parents' own service + module templates from the junction YAMLs
(`templates/_shared/junction-fan-out.mjs`, JUNC-0 #678), and `junction new` re-renders the parents through
`entity new`'s per-target path (`src/cli/shared/entity-render.ts`).

Entry point: `templates/entity/new/prompt.js`. The backend locals come from `prompt-extension.js`.

Cross-entity names in the hygen prompts (a `belongs_to` / `has_many` / field `foreign_key:` target, an EAV
definition entity, a junction or `relationship new` endpoint, a group Actor's members) come from `templates/_shared/entity-naming.mjs`:
`projectEntityLookup(cwd)` reads the target's own YAML (the entities-dir rule is the CLI's, `src/config/entities-dir.ts`), `entityModuleNaming` turns it into the
table export + module folder (`plural:`, `context:`), `relativeModuleDir` into the import path. Never
`pluralize(target)` or a hand-built `'../<plural>/'` (NAME-0, `docs/specs/NAME-0.md`).
