---
to: "<%= configPath %>"
inject: true
append: true
skip_if: "events:"
---

events:
  # ── Backend selection (core/extension model — see CLAUDE.md) ──
  # 'drizzle' is the production backend (transactional outbox). 'memory'
  # is the synchronous test backend. Future backends (e.g. 'redis',
  # 'nats') implement the same core IEventBus contract.
  backend: drizzle

  # ── Multi-tenancy (EVT-6 / ADR-024) ──
  # When true the generated schema gains a `tenant_id` column and
  # `TypedEventBus.publish` throws `MissingTenantIdError` when the caller
  # forgets `metadata.tenantId`. Enabling post-install requires a
  # reinstall (`subsystem install events`) plus an Atlas migration.
  multi_tenant: false

  # ── Optional drain-loop pool filter ──
  # Restrict this process to specific lanes. Leave commented to drain
  # all pending rows. Typical split is one process per lane so a slow
  # outbound handler cannot stall change-event propagation.
  # pools: []  # e.g. [events_inbound] | [events_change] | [events_outbound]

  # ── Backend-specific extensions (typed per backend) ──
  extensions:
    drizzle:
      # listen_notify: true        # Postgres LISTEN/NOTIFY wakes the outbox
      #                            # drainer the instant an event is published
      #                            # (in-tx pg_notify, delivered on commit),
      #                            # ALONGSIDE interval polling — polling stays
      #                            # the safety net. Sub-500ms drain vs ~1s poll.
      #                            # Off by default. REQUIRES a direct (or
      #                            # session-mode) connection — session-scoped
      #                            # LISTEN does NOT survive a transaction-mode
      #                            # pooler (PgBouncer pool_mode=transaction);
      #                            # behind one, the drainer degrades to polling.
