---
to: "<%= configPath %>"
inject: true
append: true
skip_if: "bridge:"
---

bridge:
  # ── Backend selection (core/extension model — see CLAUDE.md) ──
  # 'drizzle' is the production backend (bridge_delivery ledger + outbox
  # drain integration). 'memory' is the synchronous test backend.
  backend: drizzle

  # ── Multi-tenancy (BRIDGE-8 / ADR-023) ──
  # When true, the three enforcement sites
  # (EventFlowService.publishAndStart, BridgeDeliveryHandler.run,
  # DrizzleBridgeDeliveryRepo.insertDelivery) throw MissingTenantIdError
  # when `tenantId === undefined`. Explicit `null` always passes
  # (cross-tenant work). Pair with `BridgeModule.forRoot({ multiTenant: true })`.
  multi_tenant: false
