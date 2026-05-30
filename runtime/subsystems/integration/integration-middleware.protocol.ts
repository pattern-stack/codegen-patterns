/**
 * Integration subsystem — change-source middleware protocol (#226-1)
 *
 * `ChangeMiddleware<T>` lets consumers compose cross-cutting concerns
 * (loopback suppression, redaction, throttling) onto an `IChangeSource<T>`
 * without expanding the port. Middleware operates on the universal
 * `Change<T>` shape, not per-mode metadata, so a single middleware works
 * across poll / CDC / webhook primitives.
 *
 * Locked shape (decision memo Q2):
 *
 *   type ChangeMiddleware<T> =
 *     (next: ChangeIterator<T>) =>
 *       (subscription: IntegrationSubscriptionView, cursor: unknown | null) =>
 *         AsyncIterable<Change<T>>;
 *
 * The middleware wraps the *next* iterator factory rather than the
 * `IChangeSource` instance directly. This keeps middlewares mode-agnostic —
 * they never read `label`, never call provider-specific extensions, only
 * the cursor + subscription seam the orchestrator already passes.
 *
 * Composition runs outermost-first on the way in (`subscription, cursor`),
 * innermost-first on the way out (yielded `Change<T>`). The first
 * middleware in the array is the outermost layer.
 *
 * Loopback shipping as middleware (#226-5) is the canonical example —
 * `createLoopbackMiddleware(store)` filters echoes of local writes
 * before they reach the orchestrator's diff stage, replacing the prior
 * `@Optional() INTEGRATION_LOOPBACK_FINGERPRINT_STORE` orchestrator branch.
 */

import type {
  Change,
  IntegrationSubscriptionView,
} from './integration-change-source.protocol';

// ============================================================================
// ChangeIterator — the inner shape middleware wraps
// ============================================================================

/**
 * The cursor-aware iterator factory at the core of `IChangeSource<T>`. Once
 * `IChangeSource.listChanges` accepts `(subscription, cursor)` (#226-2), the
 * `IChangeSource<T>` instance method binds 1:1 to this signature.
 */
export type ChangeIterator<T> = (
  subscription: IntegrationSubscriptionView,
  cursor: unknown | null,
) => AsyncIterable<Change<T>>;

// ============================================================================
// ChangeMiddleware<T>
// ============================================================================

/**
 * A composable wrapper around a `ChangeIterator<T>`. Middlewares may filter,
 * transform, observe, or short-circuit the change stream; they may NOT
 * synthesize cursors out of thin air — the inner iterator owns cursor
 * advancement, middlewares only see what it yields.
 */
export type ChangeMiddleware<T> = (
  next: ChangeIterator<T>,
) => ChangeIterator<T>;

// ============================================================================
// composeChangeMiddleware — left-to-right composition helper
// ============================================================================

/**
 * Composition helper signature. Compose a middleware chain into a single
 * `ChangeIterator<T>`; the first middleware is the outermost layer (sees
 * subscription/cursor first; sees yielded changes last). The terminal
 * `inner` iterator is the underlying `IChangeSource<T>.listChanges` bound
 * to its instance.
 *
 * Implementation lands alongside `PollChangeSource<T>` (#226-3); the
 * signature is locked here as a type so middleware authors and primitive
 * implementations can target a stable shape before the runtime helper
 * ships.
 */
export type ComposeChangeMiddleware = <T>(
  inner: ChangeIterator<T>,
  middlewares: ReadonlyArray<ChangeMiddleware<T>>,
) => ChangeIterator<T>;
