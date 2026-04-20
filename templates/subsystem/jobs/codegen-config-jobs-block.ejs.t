---
to: "<%= configPath %>"
inject: true
append: true
skip_if: "jobs:"
---

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
