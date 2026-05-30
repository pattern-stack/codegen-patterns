---
to: "<%= configPath %>"
inject: true
append: true
skip_if: "integration:"
---

integration:
  # ── Backend selection (core/extension model — see CLAUDE.md) ──
  # 'drizzle' is the production backend (Postgres cursor store +
  # integration_runs / integration_run_items audit log). 'memory' is the in-process
  # test backend (MemoryCursorStore + MemoryRunRecorder).
  backend: drizzle

  # ── Multi-tenancy (SYNC-6 / ADR-008) ──
  # When true:
  #   - the generated schema gains `tenant_id` columns on all three
  #     integration tables;
  #   - `ExecuteIntegrationUseCase.execute(...)` throws `MissingTenantIdError`
  #     when called with a null / missing `tenantId`;
  #   - `PostgresCursorStore` + `DrizzleIntegrationRunRecorder` throw the same
  #     error at their write boundary (defense in depth);
  #   - `MemoryCursorStore` + `MemoryRunRecorder` accept `tenantId` and
  #     record it on their in-memory rows but do not throw — memory
  #     state is process-local; cross-tenant isolation there is not
  #     meaningful.
  # Enabling post-install requires a reinstall (`subsystem install integration
  # --force --force-config`) plus an Atlas migration.
  multi_tenant: false
