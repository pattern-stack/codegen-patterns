<!-- managed by @pattern-stack/codegen — re-run `codegen skills install` to refresh. Edit the package source, not this vendored copy. -->

# Pools, ordering and the worker

How pools work, how to configure them in `codegen.config.yaml`, how to get the ordering you need, and where the
executor runs. Read the `jobs` `SKILL.md` first.

## A pool is a limiter

A pool is a named limiter: a shared in-flight cap a step names with `step({ limiter: '<name>' })`, holding one slot
for its whole run. `interactive` (20) and `batch` (5) always exist. Configure them, or add your own, in the `jobs:`
block:

```yaml
jobs:
  worker_mode: embedded       # embedded (this process runs the executor) | standalone (bun src/worker.ts does)
  pools:
    batch:
      concurrency: 10         # re-cap a default pool
    reports:
      concurrency: 2          # a pool of your own
  # poll_interval_ms: 250     # how often an idle executor looks for work
  # open_sweep_every: 4       # polls between open-run sweeps (finds runs other processes or transactions started)
  # version_grace_ms: 0       # how long a job's old version keeps its open runs after a deploy bumps it
```

The block is generated into `<generated>/app-config.ts` (`jobLimiters`, `jobsInProcessOptions`) on every
`codegen entity new`; the app never reads the YAML. A step naming a pool with no entry stops the boot.

**Priority is a pool.** There is no priority field: work that must not wait behind other work names a pool nothing
else fills. The caps are per process: N replicas run N times each cap.

## Ordering

The engine runs one run's steps in order, and one advancer per run at a time (a lease). It does not order runs of
one job against each other; get the guarantee you need from the dedupe key:

- **One at a time per thing** (per account, per document): start with `dedupeKey: <thing id>` and
  `collision: 'queue'`. A second start is held `queued` and starts when the runs ahead of it on the key end, oldest
  first.
- **Collapse duplicates**: `dedupeKey` with `collision: 'join'` (the default) returns the open run;
  `dedupeWindowMs` also returns one that just ended.
- **Latest wins**: `collision: 'replace'` cancels the open run (and its children) and starts afresh.

Never use the dedupe key or window for the bridge's exactly-once: that is the event transaction's.

## Where the executor runs

- **`embedded`** (default): the generated `SUBSYSTEM_MODULES` compose `JobsEngineModule.forRoot({ worker: true })`;
  the executor starts with the app and drains on `app.close()`.
- **`standalone`**: the app composes `worker: false` (it starts runs, never advances them) and `bun src/worker.ts`
  runs the executor. The worker boots the same `AppModule` with no HTTP listener and calls
  `app.get(JOBS_EXECUTOR).start()`, so it runs on exactly the app's generated config; it carries none of its own.
  Run as many as you like: the advance lease keeps one advancer per run.

`src/worker.ts` is emit-once. An old one that still boots ADR-022's `JobWorkerModule` gets the one-time edit printed
by `codegen subsystem install jobs`.
