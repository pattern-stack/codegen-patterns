/**
 * Injection tokens for the bridge subsystem (ADR-023 Phase 2, BRIDGE-2).
 *
 * String constants (not Symbols) so they match by value across import
 * boundaries — same convention as `EVENT_BUS` / `EVENTS_MULTI_TENANT` in the
 * events subsystem (per EVT-6 §Implementation Notes). The jobs subsystem
 * uses Symbols for its analogous tokens; we keep the bridge file internally
 * consistent with the events convention because the bridge is conceptually
 * downstream of (and imports from) the events module.
 */

/**
 * Token for the `IJobBridge` repo backend (memory in BRIDGE-3, Drizzle in
 * BRIDGE-4). Consumed by `BridgeDeliveryHandler` (BRIDGE-5), the outbox
 * drain (BRIDGE-4 modification), and `EventFlowService` (BRIDGE-7).
 */
export const BRIDGE_DELIVERY_REPO = 'BRIDGE_DELIVERY_REPO' as const;

/**
 * Token for the `IEventFlow` facade implementation (BRIDGE-7). Use cases
 * inject this in preference to `EVENT_BUS` / `TYPED_EVENT_BUS` — calling
 * `eventFlow.publish(...)` / `eventFlow.publishAndStart(...)` is the
 * sanctioned authoring surface (ADR-023 §Decision 7).
 */
export const EVENT_FLOW = 'EVENT_FLOW' as const;

/**
 * Token for the resolved multi-tenancy flag, provided by
 * `BridgeModule.forRoot({ multiTenant })` in BRIDGE-8. Consumed by
 * `EventFlowService.publishAndStart` (entry), `BridgeDeliveryHandler.handle`
 * (entry), and `DrizzleBridgeDeliveryRepo.insertDelivery` (pre-write) — the
 * three enforcement sites called out in ADR-023 §Multi-tenancy.
 */
export const BRIDGE_MULTI_TENANT = 'BRIDGE_MULTI_TENANT' as const;

/**
 * Token for the resolved `BridgeModuleOptions` object. Provided by
 * `BridgeModule.forRoot(...)` / `forRootAsync(...)` in BRIDGE-8.
 * Mirrors `EVENTS_MODULE_OPTIONS` and `JOBS_DOMAIN_OPTIONS` shape — backends
 * inject this when they need to observe additional module configuration
 * (e.g. pool overrides) without each adding a dedicated token.
 */
export const BRIDGE_MODULE_OPTIONS = 'BRIDGE_MODULE_OPTIONS' as const;

/**
 * Token for the codegen-emitted `bridgeRegistry` — the
 * `Record<EventTypeName, BridgeTriggerEntry[]>` map that drives
 * outbox-drain trigger lookup (BRIDGE-4) and `EventFlowService` Case B
 * dedup (BRIDGE-7). Provider registration lands in BRIDGE-8; the token is
 * declared here so generated code (BRIDGE-6) can import it without
 * depending on the still-being-formalised module.
 */
export const BRIDGE_REGISTRY = 'BRIDGE_REGISTRY' as const;


/**
 * Token for the `IBridgeOutboxDrainHook` implementation (BRIDGE-4).
 * Injected `@Optional()` into `DrizzleEventBus` — when the bridge
 * subsystem is not installed the token is undefined and the events
 * outbox drain skips the bridge block entirely (preserves EVT-4
 * baseline behaviour).
 *
 * Resolution order: `BridgeModule.forRoot()` provides this token in
 * BRIDGE-8 alongside the rest of the bridge subsystem. `EventsModule`
 * itself never provides it; the events subsystem stays unaware of the
 * bridge unless the consumer wires it.
 */
export const BRIDGE_OUTBOX_DRAIN_HOOK = 'BRIDGE_OUTBOX_DRAIN_HOOK' as const;
