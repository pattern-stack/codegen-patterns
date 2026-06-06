# JOB-6 — Hygen Scaffold Templates: `src/worker.ts`, `main.ts` Hook, Config Block

**Issue:** JOB-6
**Status:** Implemented
**Last Updated:** 2026-06-06 (#513 — worker location + composition + mode-aware import)
**Depends on:** JOB-1 (schema file templated here), JOB-5 (module names must be stable)
**Blocks:** JOB-8 (multi-tenancy opt-in — tenant_id column conditional lives in this template)

> **#513 revision (2026-06-06).** The standalone worker moved from repo-root
> `worker.ts` to `src/worker.ts`, was rewritten to compose around the consumer's
> `AppModule` (handler-DI parity with the API process), and its single remaining
> runtime import (`JobWorkerModule`) now routes through the ADR-037 mode-aware
> resolver (package vs vendored). The body below is updated to that post-#513
> truth; the original 2026-04-19 design (root location, bare
> `DatabaseModule`+`JobsDomainModule` composition, hard-coded `@shared` import)
> is superseded. See `.ai-docs/specs/513.md`.

## Overview

Hygen templates that emit operational glue files when `bun codegen subsystem jobs` runs in a consumer project. Four templates: standalone `worker.ts` at project root, commented embedded-mode guidance injected into `src/main.ts`, a `jobs:` block appended to `codegen.config.yaml` with all five default pools populated, **and a templated `job-orchestration.schema.ts` that gates the `tenant_id` column on `jobs.multi_tenant` (Q1 2026-04-19 — added to JOB-6 scope because the runtime source file JOB-1 lands is always-emit; the scaffold-time conditional lives in this template layer)**. `SubsystemInstallCommand` is extended to invoke Hygen after `copyRuntime`. Scaffolded once per project, not per entity.

## Context

ADR-022: "Codegen emits both `main.ts` and `worker.ts` on scaffold. A consumer who never deploys standalone simply never runs `worker.ts`; the file is inert." JOB-6 delivers that commitment.

`templates/subsystem/jobs/` does not exist before this issue; created fresh.

## Architecture

```
SubsystemInstallCommand.execute()
  ├── copyRuntime()                            ← existing
  └── invokeHygen({ generator: 'subsystem', action: 'jobs' })
        ├── worker.ejs.t                       → <cwd>/src/worker.ts (create; skip if exists)
        ├── main-hook.ejs.t                    → inject into <cwd>/src/main.ts (once)
        └── codegen-config-jobs-block.ejs.t    → append to <cwd>/codegen.config.yaml (once)
```

## Files

| File | Action | Purpose |
|---|---|---|
| `templates/subsystem/jobs/worker.ejs.t` | create | Produces `src/worker.ts` (#513: was repo-root; now next to `app.module.ts`, inside the default tsconfig include) |
| `templates/subsystem/jobs/main-hook.ejs.t` | create | Injects embedded-mode comment block |
| `templates/subsystem/jobs/codegen-config-jobs-block.ejs.t` | create | Appends `jobs:` config block |
| `templates/subsystem/jobs/job-orchestration.schema.ejs.t` | create | **Templated schema: conditional EJS block for `tenantId` column gated on `jobs.multi_tenant` (Q1 2026-04-19)** — overrides/replaces the always-emit runtime source file landed in JOB-1 when scaffolded into a consumer project |
| `templates/subsystem/jobs/prompt.js` | create | Hygen prompt — coerces CLI string args into JS booleans so template `<% if (multiTenant) %>` gates work |
| `src/cli/shared/jobs-scaffold-locals.ts` | create | Pure resolver for Hygen locals (`resolveJobsScaffoldLocals`) + argv serialiser (`localsToHygenArgs`); CLI is a thin wrapper |
| `src/cli/commands/subsystem.ts` | modify | Invoke Hygen for `jobs` after `copyRuntime`; `copyRuntime` must skip `job-orchestration.schema.ts` since Hygen template owns it. On Hygen failure: warn but exit 0 |
| `test/run-test.ts` | modify | Render both variants of `job-orchestration.schema.ejs.t` into the baseline capture step (uses a throwaway sandbox to mute the non-schema templates during baseline capture) |
| `test/baseline/runtime/subsystems/jobs/generated/job-orchestration.schema.single-tenant.ts` | create | Baseline fixture — no `tenantId`, no `tenant_id` references anywhere |
| `test/baseline/runtime/subsystems/jobs/generated/job-orchestration.schema.multi-tenant.ts` | create | Baseline fixture — includes `tenantId: text('tenant_id')` + JOB-8 guidance comment |

## Template Variable Model

```typescript
interface JobsScaffoldLocals {
  appName: string;          // basename of cwd if config has no explicit name
  workerMode: 'embedded' | 'standalone';  // default 'embedded'
  multiTenant: boolean;     // gates the `tenantId` column in job-orchestration.schema.ejs.t (Q1 2026-04-19) and threads into codegen-config default; JOB-8 wires the service-layer flag
  mainTsPath: string;       // default 'src/main.ts'
  configPath: string;       // default 'codegen.config.yaml'
  workerExists: boolean;    // computed in CLI via fs.existsSync; used in worker template skip_if
  // #513 additions:
  workerPath: string;       // 'src/worker.ts' (was repo-root 'worker.ts')
  jobWorkerModuleImport: string;  // mode-aware (ADR-037): package → '@pattern-stack/codegen/runtime/subsystems/jobs/index'; vendored → '@shared/subsystems/jobs/index'
  workerForRootOpts: string;      // pre-serialised JobWorkerModule.forRoot(<opts>) literal; mirrors the embedded composer's backend/extension clauses, mode:'standalone' first, allPools:true last
}
```

## Template Designs

### `worker.ejs.t`

```
---
to: "<%= workerPath %>"
unless_exists: true
---
```

**Implementation note (2026-04-19):** the spec draft proposed
`skip_if: "<%= workerExists %>"`, but Hygen's `skip_if` is a regex matched
against destination-file content rather than a boolean guard. Rendering it
to the literal string `"true"` / `"false"` would only skip when that word
happened to appear in the worker file. `unless_exists: true` is Hygen's
native primitive for "create once, never overwrite" and matches the
intended semantics exactly. The CLI still computes `workerExists` for
dry-run reporting and for the templates-locals unit tests.

Content (template body): minimal NestJS `NestFactory.createApplicationContext` bootstrap — no `app.listen()`. Imports `JobWorkerModule` (mode-aware specifier) and the consumer's `AppModule` (relative `./app.module`). **#513 composition** — `WorkerAppModule` imports `AppModule` whole (handler-DI parity with the API process) plus a single `JobWorkerModule.forRoot(<opts>)`:

```ts
import { AppModule } from './app.module';
import { JobWorkerModule } from '<%= jobWorkerModuleImport %>';

@Module({
  imports: [
    AppModule, // DatabaseModule + SUBSYSTEM_MODULES + handler modules
    JobWorkerModule.forRoot(<%- workerForRootOpts %>), // e.g. { mode: 'standalone', allPools: true }
  ],
})
export class WorkerAppModule {}
```

- **AppModule composition** kills the original "empty handler DI surface" defect — a bare `DatabaseModule`+`JobsDomainModule` worker registered zero `@JobHandler` providers. Importing `AppModule` gives the worker the SAME DI graph as the HTTP process. The module is a NAMED export so boot-checks / e2e can import it without side effects.
- **`workerForRootOpts`** is built in `jobs-scaffold-locals.ts` by mirroring the embedded composer's backend + extension clauses (`subsystem-barrel-generator.ts`), but with `mode: 'standalone'` first and `allPools: true` last — so a standalone worker keeps `listen_notify`/`poll_interval_ms` (drizzle) or `backend: 'bullmq'` + its extension block, and always drains the reserved `events_*` lanes.
- **`jobWorkerModuleImport`** is the only mode-aware import (ADR-037, via `runtimeImport(mode, 'subsystems/jobs/index')`): package → `@pattern-stack/codegen/runtime/subsystems/jobs/index`, vendored → `@shared/subsystems/jobs/index`. `AppModule` is imported relatively, so it is mode-agnostic.

`bootstrap()` is gated on `if (import.meta.main)` (bun-first) so importing the module doesn't spawn a worker; the documented run command is `bun src/worker.ts`.

SIGTERM/SIGINT handler: set flag, `await app.close()`, bounded by `SHUTDOWN_TIMEOUT_MS = 30000`; errors → `process.exit(1)`.

**Operational notes (#513).** This entrypoint is for `worker_mode: standalone` only — in embedded mode `AppModule` already runs the worker, so booting this file too would double-spawn against the same pools. Also: booting a consumer `AppModule` twice in one process throws `DuplicateSchemaError` (per-process `OpenApiRegistry` singleton), so multi-rung boot validation must spawn child processes, not import both modules into one.

### `main-hook.ejs.t`

```
---
to: "<%= mainTsPath %>"
inject: true
after: "NestFactory.create"
skip_if: "JobWorkerModule"
---
```

Body (a commented guidance block injected after `NestFactory.create(...)`):

```ts
// JOBS — Embedded worker mode (optional)
// To run the job worker in-process (single-process deploy), add to AppModule imports:
//   JobWorkerModule.forRoot({ mode: 'embedded' })
// For standalone worker (separate process), run src/worker.ts (bun src/worker.ts).
// See codegen.config.yaml jobs.worker_mode to toggle the documented default.
```

If `src/main.ts` doesn't exist, Hygen skips silently; CLI layer prints a hint.

### `job-orchestration.schema.ejs.t`

**Added 2026-04-19 to resolve Q1 implementation deferral from JOB-1.**

The runtime source file at `runtime/subsystems/jobs/job-orchestration.schema.ts` (landed in JOB-1) always emits the `tenantId` column. For consumer scaffolds to respect `jobs.multi_tenant: false` (Q1: "single-tenant consumers do NOT have the column"), this template file **replaces** that runtime source during `subsystem install jobs`. `copyRuntime` must be modified to skip `job-orchestration.schema.ts` so Hygen owns the emission.

Front-matter:

```
---
to: "<%= schemaPath %>"
force: true
---
```

`schemaPath` defaults to `shared/subsystems/jobs/job-orchestration.schema.ts` (or the equivalent consumer-side path resolved from `paths.subsystems`).

Body: exact EJS port of `runtime/subsystems/jobs/job-orchestration.schema.ts` with a single EJS conditional gating the `tenantId` column definition inside `pgTable 'job_run'`:

```ejs
<% if (multiTenant) { %>
  tenantId: text('tenant_id'),                // scaffold-time conditional — see JOB-8
<% } %>
```

No other changes to the schema — all enums, other columns, indexes, and exported types are emitted identically in both variants. Index definitions that would reference `tenant_id` (none in Phase 1) must also gate on `multiTenant` if added later.

**Acceptance for this template:**
- Rendered with `multiTenant: false` → output has no `tenantId` column, no `tenant_id` references anywhere in the file.
- Rendered with `multiTenant: true` → output includes `tenantId: text('tenant_id')` on `jobRuns`, with the `// scaffold-time conditional — see JOB-8` comment.
- Baseline snapshot has two fixture outputs (single-tenant + multi-tenant) for this file.
- Enabling tenancy post-install requires `subsystem install jobs` (which now regenerates the schema) followed by an Atlas migration — no runtime toggle.

### `codegen-config-jobs-block.ejs.t`

```
---
to: "<%= configPath %>"
inject: true
append: true
skip_if: "jobs:"
---
```

Body (YAML appended):

```yaml
jobs:
  # ── Backend selection (core/extension model — see CLAUDE.md) ──
  # 'drizzle' is the only Phase 1 backend. Future backends ('bullmq', etc.)
  # implement the same core IJobOrchestrator contract but expose their own
  # native features as opt-in extensions below.
  backend: drizzle

  # ── Backend-specific extensions (typed per backend) ──
  # Each backend may publish its own extension keys. Unrecognised keys for
  # the active backend produce a config validation warning at boot.
  extensions:
    drizzle:
      # listen_notify: true        # LISTEN-NOTIFY-1: Postgres LISTEN/NOTIFY wakes
      #                            # the worker on enqueue-commit, ALONGSIDE
      #                            # interval polling (polling is the safety net).
      #                            # Off by default; requires a direct connection
      #                            # (no transaction-mode pooler).
      poll_interval_ms: 1000
    # bullmq:                      # Example shape for Phase 6+ BullMQ backend.
    #   bull_board:                # Mount Bull Board admin UI.
    #     enabled: true
    #     mount_path: /admin/queues
    #   redis_url: redis://...

  # ── Multi-tenancy (JOB-8) ──
  multi_tenant: false              # true → enforce tenantId on all calls

  # ── Worker topology ──
  worker_mode: embedded            # embedded | standalone

  # ── Pools (logical lanes; one worker per pool) ──
  pools:
    events_inbound:
      queue: jobs-events-inbound
      concurrency: 20
      reserved: true               # framework-only; user @JobHandler cannot target
    events_change:
      queue: jobs-events-change
      concurrency: 30
      reserved: true
    events_outbound:
      queue: jobs-events-outbound
      concurrency: 10
      reserved: true
    interactive:
      queue: jobs-interactive
      concurrency: 20
    batch:
      queue: jobs-batch
      concurrency: 5
```

**Design intent.** The `backend` key surfaces the architectural choice explicitly. The `extensions:` block is keyed by backend name — when a consumer switches backends, they keep only the relevant extensions and the rest become inert (validator warns rather than errors so swap is non-destructive). Comments in the scaffolded file teach the model in-place.

## Implementation Steps

1. **Create `templates/subsystem/jobs/`** — no prompt.js needed; subsystem templates called directly by CLI.
2. **Write `worker.ejs.t`** — front-matter `to: <%= workerPath %>` (= `src/worker.ts`), `unless_exists: true`; body as above. The `JobWorkerModule` import is the mode-aware `<%= jobWorkerModuleImport %>` (#513 — was hard-coded `@shared/subsystems/jobs`); `AppModule` is imported relatively.
3. **Write `main-hook.ejs.t`** — front-matter `to`, `inject: true`, `after: "NestFactory.create"`, `skip_if: "JobWorkerModule"`; body as above.
4. **Write `codegen-config-jobs-block.ejs.t`** — front-matter `to`, `inject: true`, `append: true`, `skip_if: "jobs:"`; body as above.
5. **Write `job-orchestration.schema.ejs.t`** — front-matter `to`, `force: true`; body as above (EJS port of runtime source with `<% if (multiTenant) { %>` gate around `tenantId` column).
6. **Extend `SubsystemInstallCommand.execute()`** in `src/cli/commands/subsystem.ts`:
   - Modify `copyRuntime` (or its job-subsystem path) to **skip** `job-orchestration.schema.ts` — Hygen template owns emission
   - After `copyRuntime(...)`: `if (this.name === 'jobs' && !this.dryRun)`
   - Resolve template locals from config + cwd (read `jobs.multi_tenant` from `codegen.config.yaml`; default `false` if block absent — matches first-install case)
   - Compute `workerExists` via `fs.existsSync(path.join(ctx.cwd, 'src', 'worker.ts'))` (#513)
   - Call `invokeHygen({ generator: 'subsystem', action: 'jobs', args: [...], cwd: ctx.cwd })`
   - On Hygen failure: warn but exit 0 — runtime files already written; partial scaffold > hard failure
   - Dry-run: print files Hygen would emit; skip actual invocation
6. **Update baseline snapshot** — `just test-baseline --update` after manual walkthrough confirms output.

## Interaction with Existing Jobs Subsystem

- `runtime/subsystems/jobs/` (executor-layer `IJobQueue`) is copied verbatim by `copyRuntime`. JOB-6 does not touch it.
- New Hygen templates live in `templates/subsystem/jobs/` (directory does not exist pre-JOB-6). No conflict with `templates/entity/new/`.
- Config block `skip_if: "jobs:"` handles the case where JOB-8's upgrade command has already written a `jobs:` key.

## Acceptance Criteria

**Concrete walkthrough (the "four files" test plan):**

1. Fresh directory; `bun codegen project init` produces `codegen.config.yaml` + scaffold.
2. `just gen-subsystem jobs` → exits 0.
3. Assert post-run state:
   - `shared/subsystems/jobs/` populated with executor-layer runtime files
   - `src/worker.ts` (#513) — imports `AppModule` (relative) + `JobWorkerModule.forRoot({ mode: 'standalone', allPools: true, … })`, no `app.listen()`, `bootstrap()` gated on `import.meta.main`
   - `codegen.config.yaml` — contains full `jobs:` block with all five pools
   - `src/main.ts` (if exists) — contains commented JOBS guidance block
4. Second run of `just gen-subsystem jobs`:
   - `src/worker.ts` not overwritten (`unless_exists`)
   - `codegen.config.yaml` has no duplicate `jobs:` block
   - `src/main.ts` has no duplicate comment block

**Criteria from issue list:**
- [x] `src/worker.ts` imports `JobWorkerModule` + composes `AppModule`; boots NestJS app context without HTTP listener (#513)
- [x] Config block has five default pools with `reserved: true` on `events_*` three
- [x] `just test-baseline` passes
- [x] `job-orchestration.schema.ejs.t` rendered with `multiTenant: false` emits a schema file with NO `tenantId` column and NO references to `tenant_id`; rendered with `multiTenant: true` emits the column with the `// scaffold-time conditional — see JOB-8` comment (Q1 resolved 2026-04-19)
- [x] `copyRuntime` skips `job-orchestration.schema.ts` so Hygen template is the sole emitter in a scaffolded project
- [x] Baseline has two fixture outputs: single-tenant (no column) + multi-tenant (with column)

## Testing Strategy

- **Baseline snapshot** — `just test-baseline` (`bun test/run-test.ts full`) renders both variants of `job-orchestration.schema.ejs.t` (single-tenant + multi-tenant) into `runtime/subsystems/jobs/generated/` and compares against `test/baseline/`. The two fixture files live under `test/baseline/runtime/subsystems/jobs/generated/job-orchestration.schema.{single,multi}-tenant.ts`. The baseline capture step uses a throwaway sandbox directory (`test/.jobs-baseline-sandbox`) to mute the non-schema templates (worker.ts, main.ts hook, config block) — they'd otherwise target ROOT during the capture and pollute the workspace.
- **Unit test** for template-variable resolution: `src/cli/shared/jobs-scaffold-locals.ts` exports `resolveJobsScaffoldLocals` (pure — filesystem probed via injected `fileExists`) and `localsToHygenArgs`. Tests cover the skip_if boolean serialisation contract (worker.ts safety: empty string when absent, `'true'` when present), multi_tenant truthiness (only literal `true` flips the flag — defends against YAML surprises like `'yes'` / `1`), worker_mode normalisation, and custom `paths.subsystems` flowing into `schemaPath`.
- **Manual walkthrough** — see PR description for scratch-project run. Four-files test plan passes; second run is fully idempotent (worker.ts skipped via `unless_exists: true`, `codegen.config.yaml` `jobs:` block has no duplicate via `skip_if: "jobs:"`, `src/main.ts` JOBS comment has no duplicate via `skip_if: "JobWorkerModule"`, schema is force-re-rendered identically).

No Docker required. Hygen invocation tested via baseline fixture in CI.

## Scope Boundary

- **Owns** the `tenant_id` schema conditional (Q1 resolved 2026-04-19 — moved into JOB-6 scope because the runtime source file in JOB-1 is always-emit). JOB-8 wires the service-layer `multiTenant` flag + Atlas docs.
- **No upgrade path needed** — no existing users; fresh-install is the only path
- **Does not** generate user-job handler classes — ADR-022 explicitly rejects jobs-as-YAML
- **Does not** modify `src/main.ts` beyond commented block — uncommenting = consumer decision
- ~~`worker.ts` uses hard-coded `@shared/subsystems/jobs` import path~~ **Resolved by #513.** The worker's `JobWorkerModule` import now routes through the ADR-037 mode-aware resolver (package → `@pattern-stack/codegen/runtime/subsystems/jobs/index`, vendored → `@shared/subsystems/jobs/index`); `AppModule` is imported relatively. (`workerPath`/`mainTsPath` still hard-code `src/`; threading `paths.backend_src` into this resolver remains out of scope — it would move both together.)

## #513 implementation notes (discovered during build)

Two things the #513 design missed, recorded here as post-implementation truth:

1. **`workerForRootOpts` is base64-encoded across the hygen arg boundary.** The
   forRoot options are a TS object literal (`{ mode: 'standalone', allPools: true }`).
   Hygen's yargs CLI parser reads the `{ … : … }` syntax as nested object /
   dot-notation and shreds it — the value reaches `prompt.js` as `{`, rendering
   `JobWorkerModule.forRoot({)` (`TS1136: Property assignment expected`). The fix:
   `encodeWorkerForRootOpts` (`src/cli/shared/jobs-scaffold-locals.ts`, applied in
   `localsToHygenArgs` to the `--workerForRootOpts` value only) ↔
   `decodeWorkerForRootOpts` (`templates/subsystem/jobs/prompt.js`, with a
   round-trip guard so a hand-passed plain literal still works). The
   `jobWorkerModuleImport` specifier has no brace/colon syntax, so it passes through
   untouched. The resolver's `workerForRootOpts` field stays the plain string the
   unit tests assert; only the argv crossing is encoded.

2. **Package mode never reaches this scaffold (follow-up: #517).** In
   `runtime: package` mode (the ADR-037 default), `SubsystemInstallCommand`
   short-circuits via `executePackageMode` (`src/cli/commands/subsystem.ts:382`) and
   returns BEFORE `runJobsScaffold` — package mode vendors no files, so the whole
   hygen scaffold (worker, main-hook, schema template) is skipped. **The worker is
   therefore never emitted in package mode today.** #513 made the worker
   package-*correct* (the mode-aware `jobWorkerModuleImport` resolves to the package
   runtime; the AppModule composition is mode-agnostic) and that branch is covered by
   unit tests + a direct template render — but it is unit-test-only until the
   package-mode install path is wired to emit it. Wiring requires extending
   `executePackageMode` to run ONLY the worker template (NOT the vendored
   `job-orchestration.schema.ejs.t`, whose target package mode deliberately doesn't
   own). Tracked in **issue #517**.

## Open Questions (non-blocking)

- `main-hook.ejs.t` uses `after: "NestFactory.create"` as injection anchor. If consumer uses `NestFactory.createMicroservice` instead, injection silently skips. CLI should print info message when `main.ts` exists but injection result can't be confirmed. Cosmetic; scaffold still functional.

## References

- ADR-022 "Worker lifecycle", "Pools", "Codegen scope"
- `docs/specs/ADR-022-phase-1-issues.md` — issue definition
- `src/cli/commands/subsystem.ts` — existing `copyRuntime` integration
- `src/cli/shared/hygen.ts` — `invokeHygen` helper
- `templates/entity/new/clean-lite-ps/module.ejs.t` — Hygen front-matter reference
- `templates/entity/new/backend/modules/core/_inject-token.ejs.t` — inject template reference
