# JOB-6 — Hygen Scaffold Templates: `worker.ts`, `main.ts` Hook, Config Block

**Issue:** JOB-6
**Status:** Draft
**Last Updated:** 2026-04-19
**Depends on:** JOB-1 (schema file templated here), JOB-5 (module names must be stable)
**Blocks:** JOB-8 (multi-tenancy opt-in — tenant_id column conditional lives in this template)

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
        ├── worker.ejs.t                       → <cwd>/worker.ts (create; skip if exists)
        ├── main-hook.ejs.t                    → inject into <cwd>/src/main.ts (once)
        └── codegen-config-jobs-block.ejs.t    → append to <cwd>/codegen.config.yaml (once)
```

## Files

| File | Action | Purpose |
|---|---|---|
| `templates/subsystem/jobs/worker.ejs.t` | create | Produces `worker.ts` at project root |
| `templates/subsystem/jobs/main-hook.ejs.t` | create | Injects embedded-mode comment block |
| `templates/subsystem/jobs/codegen-config-jobs-block.ejs.t` | create | Appends `jobs:` config block |
| `templates/subsystem/jobs/job-orchestration.schema.ejs.t` | create | **Templated schema: conditional EJS block for `tenantId` column gated on `jobs.multi_tenant` (Q1 2026-04-19)** — overrides/replaces the always-emit runtime source file landed in JOB-1 when scaffolded into a consumer project |
| `src/cli/commands/subsystem.ts` | modify | Invoke Hygen for `jobs` after `copyRuntime`; `copyRuntime` must skip `job-orchestration.schema.ts` since Hygen template owns it |
| `test/baseline/` | modify | Update snapshot — two fixtures: single-tenant (no `tenantId`) + multi-tenant (with `tenantId`) |

## Template Variable Model

```typescript
interface JobsScaffoldLocals {
  appName: string;          // basename of cwd if config has no explicit name
  workerMode: 'embedded' | 'standalone';  // default 'embedded'
  multiTenant: boolean;     // gates the `tenantId` column in job-orchestration.schema.ejs.t (Q1 2026-04-19) and threads into codegen-config default; JOB-8 wires the service-layer flag
  mainTsPath: string;       // default 'src/main.ts'
  configPath: string;       // default 'codegen.config.yaml'
  workerExists: boolean;    // computed in CLI via fs.existsSync; used in worker template skip_if
}
```

## Template Designs

### `worker.ejs.t`

```
---
to: "<%= workerPath %>"
skip_if: "<%= workerExists %>"
---
```

Content (template body): minimal NestJS `NestFactory.createApplicationContext` bootstrap — no `app.listen()`. Imports `JobWorkerModule`, `DatabaseModule`, `JobsDomainModule`. Inline `WorkerAppModule` with:

```ts
@Module({
  imports: [
    DatabaseModule,
    JobsDomainModule.forRoot({ backend: 'drizzle' }),
    JobWorkerModule.forRoot({ mode: 'standalone' }),
  ],
})
class WorkerAppModule {}
```

SIGTERM handler: set flag, `await app.close()`, bounded by `SHUTDOWN_TIMEOUT_MS = 30000`. `bootstrap()` called at bottom; errors → `process.exit(1)`.

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
// For standalone worker (separate process), use worker.ts at the project root.
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
      # listen_notify: true        # use Postgres LISTEN/NOTIFY to wake the
      #                            # polling loop instead of (or alongside)
      #                            # interval polling. Disabled by default.
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
2. **Write `worker.ejs.t`** — front-matter `to`, `skip_if: workerExists`; body as above. Import path `@shared/subsystems/jobs` (consumer-side location after `copyRuntime`).
3. **Write `main-hook.ejs.t`** — front-matter `to`, `inject: true`, `after: "NestFactory.create"`, `skip_if: "JobWorkerModule"`; body as above.
4. **Write `codegen-config-jobs-block.ejs.t`** — front-matter `to`, `inject: true`, `append: true`, `skip_if: "jobs:"`; body as above.
5. **Write `job-orchestration.schema.ejs.t`** — front-matter `to`, `force: true`; body as above (EJS port of runtime source with `<% if (multiTenant) { %>` gate around `tenantId` column).
6. **Extend `SubsystemInstallCommand.execute()`** in `src/cli/commands/subsystem.ts`:
   - Modify `copyRuntime` (or its job-subsystem path) to **skip** `job-orchestration.schema.ts` — Hygen template owns emission
   - After `copyRuntime(...)`: `if (this.name === 'jobs' && !this.dryRun)`
   - Resolve template locals from config + cwd (read `jobs.multi_tenant` from `codegen.config.yaml`; default `false` if block absent — matches first-install case)
   - Compute `workerExists` via `fs.existsSync(path.join(ctx.cwd, 'worker.ts'))`
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
   - `worker.ts` at project root — imports `JobWorkerModule.forRoot({ mode: 'standalone' })`, no `app.listen()`
   - `codegen.config.yaml` — contains full `jobs:` block with all five pools
   - `src/main.ts` (if exists) — contains commented JOBS guidance block
4. Second run of `just gen-subsystem jobs`:
   - `worker.ts` not overwritten (skip_if)
   - `codegen.config.yaml` has no duplicate `jobs:` block
   - `src/main.ts` has no duplicate comment block

**Criteria from issue list:**
- [ ] `worker.ts` imports `JobWorkerModule`; boots NestJS app context without HTTP listener
- [ ] Config block has five default pools with `reserved: true` on `events_*` three
- [ ] `just test-baseline` passes
- [ ] `job-orchestration.schema.ejs.t` rendered with `multiTenant: false` emits a schema file with NO `tenantId` column and NO references to `tenant_id`; rendered with `multiTenant: true` emits the column with the `// scaffold-time conditional — see JOB-8` comment (Q1 resolved 2026-04-19)
- [ ] `copyRuntime` skips `job-orchestration.schema.ts` so Hygen template is the sole emitter in a scaffolded project
- [ ] Baseline has two fixture outputs: single-tenant (no column) + multi-tenant (with column)

## Testing Strategy

- **Baseline snapshot** — `just test-baseline` runs `subsystem install jobs` on fixture project and compares output to committed snapshots. Update as part of PR.
- **Unit test** for template-variable resolution: extract resolution logic to pure function; test with various config inputs.
- **Manual walkthrough** documented in PR description: fresh `bun init` project, run the commands, inspect output, verify four-files test plan passes, confirm idempotency on re-run.

No Docker required. Hygen invocation tested via baseline fixture in CI.

## Scope Boundary

- **Owns** the `tenant_id` schema conditional (Q1 resolved 2026-04-19 — moved into JOB-6 scope because the runtime source file in JOB-1 is always-emit). JOB-8 wires the service-layer `multiTenant` flag + Atlas docs.
- **No upgrade path needed** — no existing users; fresh-install is the only path
- **Does not** generate user-job handler classes — ADR-022 explicitly rejects jobs-as-YAML
- **Does not** modify `src/main.ts` beyond commented block — uncommenting = consumer decision
- `worker.ts` uses hard-coded `@shared/subsystems/jobs` import path — non-standard `paths.subsystems` config would produce wrong path; flagged as known limitation, not blocking; follow-up can make path template-variable-driven

## Open Questions (non-blocking)

- `main-hook.ejs.t` uses `after: "NestFactory.create"` as injection anchor. If consumer uses `NestFactory.createMicroservice` instead, injection silently skips. CLI should print info message when `main.ts` exists but injection result can't be confirmed. Cosmetic; scaffold still functional.

## References

- ADR-022 "Worker lifecycle", "Pools", "Codegen scope"
- `docs/specs/ADR-022-phase-1-issues.md` — issue definition
- `src/cli/commands/subsystem.ts` — existing `copyRuntime` integration
- `src/cli/shared/hygen.ts` — `invokeHygen` helper
- `templates/entity/new/clean-lite-ps/module.ejs.t` — Hygen front-matter reference
- `templates/entity/new/backend/modules/core/_inject-token.ejs.t` — inject template reference
