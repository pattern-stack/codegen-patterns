---
to: "<%= configPath %>"
inject: true
append: true
skip_if: "jobs:"
---

jobs:
  # @pattern-stack/jobs, run in process (JOBS-3): jobs are `defineJob` values under src/jobs/, the store is this
  # app's Postgres, and the executor sweeps open runs and leases each one, so replicas never advance a run twice.

  # A run's tenant is the one its start names (JobStarter.start({ tenantId }); the bridge passes the event's);
  # a start that names none runs as SYSTEM_TENANT, the null tenant partition.

  # ── Worker topology ──
  worker_mode: embedded            # embedded (this process runs the executor) | standalone (bun src/worker.ts does)

  # ── Pools: limiters a step names (`step({ limiter: 'batch' })`) ──
  # `interactive` (20) and `batch` (5) always exist; set one to change its cap, or add your own. Priority is a pool:
  # work that must not wait behind other work names a pool nothing else fills. A step naming an undeclared pool stops
  # the boot. The generator writes this block into <generated>/app-config.ts; the app never reads this file.
  # pools:
  #   batch:
  #     concurrency: 10
  #   reports:
  #     concurrency: 2

  # ── The executor (defaults shown) ──
  # poll_interval_ms: 250          # how often an idle executor looks for work
  # open_sweep_every: 4            # polls between open-run sweeps (finds runs other processes started)
  # version_grace_ms: 0            # set above a deploy's length when replicas roll: the old version's open runs drain
