/**
 * Mail adapter conformance helper (ADR-036 §10).
 *
 * `assertMailAdapter` structurally verifies a `MailPort` implementation so
 * consumer adapter tests catch wiring mistakes (a missing L1 slot, an entity
 * declared in `capabilities.entities` with no registered change source) at test
 * time rather than at NestJS boot or first use.
 *
 * Shipped from the `@pattern-stack/codegen-mail/testing` subpath — a test-time
 * helper, kept out of the package's main runtime barrel.
 */

import type { MailPort } from '../mail.port';

/**
 * Structurally verify a `MailPort` implementation. Collects every failure and
 * throws a single `AggregateError` listing them all (rather than failing on the
 * first), so a test reports the complete conformance gap in one run.
 *
 * Checks:
 *   1. Required L1 slots (`auth`, `sources`) resolve to non-null objects.
 *   2. `capabilities` resolves.
 *   3. Every `capabilities.entities` entry resolves via `sources.has(name)`.
 *
 * @throws AggregateError when any check fails.
 */
export function assertMailAdapter(adapter: MailPort): void {
  const failures: Error[] = [];

  // 1. Required L1 slots.
  if (!adapter.auth) failures.push(new Error('MailPort.auth missing'));
  if (!adapter.sources) failures.push(new Error('MailPort.sources missing'));

  // 2. Capability descriptor + 3. entity coverage matches the registry.
  const caps = adapter.capabilities;
  if (!caps) {
    failures.push(new Error('MailPort.capabilities missing'));
  } else if (adapter.sources) {
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

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `MailPort conformance failed (${failures.length} issue${failures.length === 1 ? '' : 's'})`,
    );
  }
}
