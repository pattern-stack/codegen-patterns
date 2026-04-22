/**
 * `BRIDGE_RESERVED_POOLS` — the three reserved bridge pools that workers
 * must claim from for bridge fanout to function (BRIDGE-8, ADR-022 +
 * ADR-023).
 *
 * Consumers spread this into their `JobWorkerModule.forRoot({ pools })`
 * configuration to ensure bridge wrappers are picked up:
 *
 * ```ts
 * import { BRIDGE_RESERVED_POOLS } from '@/runtime/subsystems/bridge';
 *
 * JobWorkerModule.forRoot({
 *   mode: 'embedded',
 *   pools: ['interactive', 'batch', ...BRIDGE_RESERVED_POOLS],
 * });
 * ```
 *
 * Cross-link: `BridgeModule.onModuleInit` (BRIDGE-8) compares this list
 * against the worker module's active pools and throws
 * `BridgeReservedPoolsNotPolledError` when any are missing — this turns
 * the silent footgun ("wrappers sit pending forever") into a fail-fast
 * at boot.
 *
 * Lives in its own file (re-exported from the barrel) to keep the
 * `BridgeModule` import graph acyclic — `bridge.module.ts` imports from
 * here, and the barrel re-exports both. Consumers only ever import from
 * the barrel.
 */

export const BRIDGE_RESERVED_POOLS = [
  'events_inbound',
  'events_change',
  'events_outbound',
] as const;

export type BridgeReservedPool = (typeof BRIDGE_RESERVED_POOLS)[number];
