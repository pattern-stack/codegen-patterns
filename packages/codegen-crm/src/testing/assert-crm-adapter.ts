/**
 * CRM adapter conformance helper (Track C · C6, #337; ADR-036 §10).
 *
 * `assertCrmAdapter` structurally verifies a `CrmPort` implementation so
 * consumer adapter tests can catch wiring mistakes (a missing port slot, a
 * capability flag that doesn't match an implemented port, an entity declared in
 * `capabilities.entities` with no registered change source) at test time rather
 * than at NestJS boot or first use.
 *
 * Shipped from the `@pattern-stack/codegen-crm/testing` subpath — a test-time
 * helper, kept out of the package's main runtime barrel.
 */

import type { CrmPort } from '../ports/crm.port';

export interface AssertCrmAdapterOptions {
  /**
   * When true (default), a capability flag set to `true` requires the matching
   * port slot to be present, AND a port slot that IS present requires its
   * capability flag to be `true` (no silently-undeclared ports). When false,
   * only the "capability true ⇒ port present" direction is checked.
   */
  respectCapabilities?: boolean;
}

/**
 * Structurally verify a `CrmPort` implementation. Collects every failure and
 * throws a single `AggregateError` listing them all (rather than failing on the
 * first), so a test reports the complete conformance gap in one run.
 *
 * Checks:
 *   1. Required L1 slots (`auth`, `sources`) resolve to non-null objects.
 *   2. Capability-driven L2 slots: `capabilities.<port>` ⇒ the slot is present;
 *      and (when `respectCapabilities`) a present slot ⇒ its flag is `true`.
 *   3. Every `capabilities.entities` entry resolves via `sources.has(name)`.
 *
 * @throws AggregateError when any check fails.
 */
export function assertCrmAdapter(
  adapter: CrmPort,
  opts: AssertCrmAdapterOptions = {},
): void {
  const respectCapabilities = opts.respectCapabilities ?? true;
  const failures: Error[] = [];

  // 1. Required L1 slots.
  if (!adapter.auth) failures.push(new Error('CrmPort.auth missing'));
  if (!adapter.sources) failures.push(new Error('CrmPort.sources missing'));

  // 2. Capability-driven L2 slots.
  const caps = adapter.capabilities;
  if (!caps) {
    failures.push(new Error('CrmPort.capabilities missing'));
  } else {
    const l2: ReadonlyArray<[keyof CrmPort, keyof typeof caps, string]> = [
      ['fields', 'fieldDefinitions', 'fields'],
      ['picklists', 'picklists', 'picklists'],
      ['associations', 'associations', 'associations'],
    ];
    for (const [slot, flag, label] of l2) {
      const declared = caps[flag] === true;
      const present = Boolean(adapter[slot]);
      if (declared && !present) {
        failures.push(
          new Error(`caps.${String(flag)}=true but CrmPort.${label} missing`),
        );
      }
      if (respectCapabilities && present && !declared) {
        failures.push(
          new Error(
            `CrmPort.${label} present but caps.${String(flag)} is not true`,
          ),
        );
      }
    }

    // 3. Entity coverage matches the change-source registry.
    if (adapter.sources) {
      for (const entity of caps.entities) {
        if (!adapter.sources.has(entity)) {
          failures.push(
            new Error(
              `caps.entities lists '${entity}' but sources.has('${entity}') is false`,
            ),
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `CrmPort conformance failed (${failures.length} issue${failures.length === 1 ? '' : 's'})`,
    );
  }
}
