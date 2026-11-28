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
  backend: <%= backend %>

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

  # ── Default-differ tuning (DIFFER-UNIGNORE) ──
  # Threaded into the `DeepEqualDiffer` bound to INTEGRATION_FIELD_DIFFER.
  # Off-by-default — omit the whole `differ:` block for the historical
  # behaviour (the built-in ignore list, unchanged). A feature module that
  # binds its own `IFieldDiffer<T>` overrides this entirely.
  #
  # differ:
  #   # Extra field names to ALSO ignore (merged with the defaults).
  #   ignore: [internalSeq]
  #   # Default-ignored field names to RE-INCLUDE as domain data. The canonical
  #   # case: an entity with `softDelete: false` whose `deletedAt` carries a
  #   # vendor-observed retraction tombstone ON the canonical record. Without
  #   # this the tombstone overlay diffs to 'noop', the upsert is skipped, and
  #   # `deleted_at` never lands. `unignore` is subtracted after `ignore`, so it
  #   # wins on a field listed in both.
  #   unignore: [deletedAt]
