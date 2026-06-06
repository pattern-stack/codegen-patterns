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
      # listen_notify: true        # Postgres LISTEN/NOTIFY wakes the worker the
      #                            # instant a job is enqueued (in-tx pg_notify,
      #                            # delivered on commit), ALONGSIDE interval
      #                            # polling — polling stays the safety net, so a
      #                            # lost notify costs latency, never work.
      #                            # Sub-500ms claim vs ~1s/poll-hop. Off by
      #                            # default. REQUIRES a direct (or session-mode)
      #                            # connection — session-scoped LISTEN does NOT
      #                            # survive a transaction-mode pooler (PgBouncer
      #                            # pool_mode=transaction); behind one, notifies
      #                            # are simply never received and the worker
      #                            # degrades to polling.
      poll_interval_ms: 1000       # interval-poll heartbeat (the wake fallback)
      # ── Claim lease / heartbeat (CLAIM-HB-1) ──
      # A live worker renews `claimed_at` for its in-flight runs every
      # `claim_heartbeat_interval_ms`, so a legitimately long-running handler is
      # NEVER swept; only a row whose worker died ages past
      # `stale_threshold_ms` and is reset to `pending` by the sweeper. Raise the
      # threshold only if you expect worker-crash recovery to wait longer; the
      # heartbeat (not the threshold) is what protects long handlers.
      # stale_threshold_ms: 300000          # dead-worker recovery window (5 min)
      # stale_sweeper_interval_ms: 60000    # how often the sweeper scans
      # claim_heartbeat_interval_ms: 100000 # lease renewal cadence
      #                                     # (default = stale_threshold_ms / 3)
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
