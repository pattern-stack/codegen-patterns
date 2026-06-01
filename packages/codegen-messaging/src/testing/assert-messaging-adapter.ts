/**
 * Messaging adapter conformance helper (ADR-036 §10).
 *
 * `assertMessagingAdapter` structurally verifies a `MessagingPort` implementation
 * so consumer adapter tests catch wiring mistakes (a missing L1 slot, an entity
 * declared in `capabilities.entities` with no registered change source, a
 * `canWrite` descriptor with no `write` seam) at test time rather than at NestJS
 * boot or first use. This is also the falsifier-suite entry point a second vendor
 * (Teams/Discord) runs against to promote the port from provisional to stable
 * (hard rule #8).
 *
 * Shipped from the `@pattern-stack/codegen-messaging/testing` subpath — a
 * test-time helper, kept out of the package's main runtime barrel.
 */

import type { MessagingPort } from '../messaging.port';

/**
 * Structurally verify a `MessagingPort` implementation. Collects every failure
 * and throws a single `AggregateError` listing them all (rather than failing on
 * the first), so a test reports the complete conformance gap in one run.
 *
 * Checks:
 *   1. Required L1 slots (`auth`, `changeSources`) resolve to non-null objects.
 *   2. `capabilities` resolves.
 *   3. Every `capabilities.entities` entry has a registered `changeSources` entry.
 *   4. If `capabilities.canWrite` is set, the `write` seam is present (ADR-0008 §9).
 *
 * @throws AggregateError when any check fails.
 */
export function assertMessagingAdapter(adapter: MessagingPort): void {
  const failures: Error[] = [];

  // 1. Required L1 slots.
  if (!adapter.auth) failures.push(new Error('MessagingPort.auth missing'));
  if (!adapter.changeSources)
    failures.push(new Error('MessagingPort.changeSources missing'));

  // 2. Capability descriptor + 3. entity coverage matches the contributions.
  const caps = adapter.capabilities;
  if (!caps) {
    failures.push(new Error('MessagingPort.capabilities missing'));
  } else {
    if (adapter.changeSources) {
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

    // 4. Write capability ↔ descriptor consistency (ADR-0008 §9).
    if (caps.canWrite && !adapter.write) {
      failures.push(
        new Error(
          'capabilities.canWrite is true but MessagingPort.write is missing',
        ),
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `MessagingPort conformance failed (${failures.length} issue${failures.length === 1 ? '' : 's'})`,
    );
  }
}
