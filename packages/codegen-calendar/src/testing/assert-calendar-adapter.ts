/**
 * Calendar adapter conformance helper (ADR-036 §10).
 *
 * `assertCalendarAdapter` structurally verifies a `CalendarPort` implementation
 * so consumer adapter tests catch wiring mistakes (a missing L1 slot, an entity
 * declared in `capabilities.entities` with no registered change source) at test
 * time rather than at NestJS boot or first use.
 *
 * Shipped from the `@pattern-stack/codegen-calendar/testing` subpath — a
 * test-time helper, kept out of the package's main runtime barrel.
 */

import type { CalendarPort } from '../calendar.port';

/**
 * Structurally verify a `CalendarPort` implementation. Collects every failure
 * and throws a single `AggregateError` listing them all (rather than failing on
 * the first), so a test reports the complete conformance gap in one run.
 *
 * Checks:
 *   1. Required L1 slots (`auth`, `changeSources`) resolve to non-null objects.
 *   2. `capabilities` resolves.
 *   3. Every `capabilities.entities` entry has a registered `changeSources` entry.
 *
 * @throws AggregateError when any check fails.
 */
export function assertCalendarAdapter(adapter: CalendarPort): void {
  const failures: Error[] = [];

  // 1. Required L1 slots.
  if (!adapter.auth) failures.push(new Error('CalendarPort.auth missing'));
  if (!adapter.changeSources)
    failures.push(new Error('CalendarPort.changeSources missing'));

  // 2. Capability descriptor + 3. entity coverage matches the contributions.
  const caps = adapter.capabilities;
  if (!caps) {
    failures.push(new Error('CalendarPort.capabilities missing'));
  } else if (adapter.changeSources) {
    for (const entity of caps.entities) {
      if (!(entity in adapter.changeSources)) {
        failures.push(
          new Error(
            `caps.entities lists '${entity}' but changeSources['${entity}'] is missing`,
          ),
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `CalendarPort conformance failed (${failures.length} issue${failures.length === 1 ? '' : 's'})`,
    );
  }
}
