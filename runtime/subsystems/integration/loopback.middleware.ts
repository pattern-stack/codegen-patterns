/**
 * Integration subsystem — loopback `ChangeMiddleware` factory (#226-5, ADR-033).
 *
 * Replaces the prior orchestrator-side `@Optional() INTEGRATION_LOOPBACK_FINGERPRINT_STORE`
 * branch. Consumers that need to suppress echoes of their own outbound
 * writes compose `createLoopbackMiddleware(store)` into a primitive's
 * middleware chain — typically alongside `PollChangeSource<T>` — instead
 * of injecting a store into the orchestrator.
 *
 * Why middleware, not orchestrator branch:
 *   - keeps the orchestrator port-agnostic (no per-mode special cases);
 *   - lets primitives compose loopback with redaction / throttling /
 *     other cross-cutting wrappers in a single chain;
 *   - lets consumers pick per-source whether loopback is wired (some
 *     entities have outbound writeback, others don't) without DI gymnastics.
 *
 * Behavior:
 *   - For every change yielded by the inner iterator, call
 *     `store.isEchoOfOwnWrite(subscription.domain, change.externalId, change.record)`.
 *   - If the store returns `true`, the change is dropped (not yielded).
 *   - Otherwise the change is passed through untouched.
 *
 * The middleware does not record audit rows for suppressed changes —
 * the orchestrator no longer learns about them. This is the deliberate
 * trade: loopback echoes are noise, not signal; their prior `skipped+noop`
 * audit rows existed only because the orchestrator was the suppression
 * site. Consumers wanting visibility into suppression counts can wrap
 * their store or layer a counting middleware alongside this one.
 */

import type { Change } from './integration-change-source.protocol';
import type {
  ChangeIterator,
  ChangeMiddleware,
} from './integration-middleware.protocol';
import type { ILoopbackFingerprintStore } from './integration-loopback.protocol';

/**
 * Build a `ChangeMiddleware<T>` that suppresses changes whose fingerprint
 * matches a recent local write according to the supplied store.
 *
 * Composition — first middleware in the array is outermost. Consumers
 * typically place loopback as the outermost layer so suppressed changes
 * never reach downstream middleware (redaction, transforms, etc.).
 */
export function createLoopbackMiddleware<T>(
  store: ILoopbackFingerprintStore<T>,
): ChangeMiddleware<T> {
  return (next: ChangeIterator<T>): ChangeIterator<T> => {
    return async function* (subscription, cursor): AsyncIterable<Change<T>> {
      for await (const change of next(subscription, cursor)) {
        const isEcho = await store.isEchoOfOwnWrite(
          subscription.domain,
          change.externalId,
          change.record,
        );
        if (isEcho) continue;
        yield change;
      }
    };
  };
}
