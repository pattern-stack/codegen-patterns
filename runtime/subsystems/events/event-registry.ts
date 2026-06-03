/**
 * Augmentable domain-event registry (ADR-037, package-mode trigger typing).
 *
 * This is the seam that lets the bridge + job-trigger types see a PACKAGE-MODE
 * consumer's OWN events with full per-event payload typing — without the
 * package shipping (and leaking) its internal test-fixture event union.
 *
 * ── The problem ──────────────────────────────────────────────────────────────
 * In vendored mode, `bridge.protocol.ts` / `job-handler.base.ts` could import
 * `EventTypeName` / `EventOfType` straight from the consumer's vendored
 * `./generated/types` (a sibling file). In package mode the runtime is consumed
 * from the published `@pattern-stack/codegen`, whose bundled
 * `events/generated/types.ts` is the codegen-patterns repo's OWN fixture union
 * (`contact_created`, `deal_created`, …). Keying the bridge/trigger types off
 * THAT union rejects the consumer's events (`'inbound_webhook_received' is not
 * assignable to '"contact_created" | …'`).
 *
 * ── The fix ──────────────────────────────────────────────────────────────────
 * `EventTypeName` (as used by the bridge/trigger types) derives from an EMPTY,
 * augmentable `DomainEventRegistry` interface instead of the bundled concrete
 * union. A package-mode consumer's generated events code emits a
 * `declare module '@pattern-stack/codegen/runtime/subsystems/events/index' {
 *    interface DomainEventRegistry { <their_event>: <TheirEvent>; … } }`
 * augmentation, so in the consumer's tsc program `keyof DomainEventRegistry`
 * picks up THEIR events and `EventOfType<T>` resolves THEIR concrete payloads.
 *
 * In the package's OWN program (and any consumer that authors no events) the
 * interface is never augmented, so `keyof DomainEventRegistry` is `never` and
 * `EventTypeName` falls back to `string` — the bridge/trigger types degrade to
 * `Record<string, …>` / `(event: DomainEvent) => …`, exactly the loose-but-
 * sound shape that keeps the package's fixture-based runtime tests green.
 *
 * The bundled `events/generated/{types,bus,schemas}.ts` keep their concrete
 * fixture union locally (the bundled `TypedEventBus` keys off `./types`, NOT
 * this file), so they do NOT augment `DomainEventRegistry` and never leak the
 * fixtures into a consumer's `EventTypeName` — even though the consumer pulls
 * `generated/types.d.ts` in transitively via the events index barrel.
 */
import type { DomainEvent } from './event-bus.protocol';

/**
 * Empty marker interface, augmented by a consumer's generated events code via
 * declaration merging on the events index module specifier
 * (`@pattern-stack/codegen/runtime/subsystems/events/index`). Each key is an
 * event `type` literal; each value is the event's concrete interface (extends
 * `DomainEvent`). Empty in the package and in any project that declares no
 * `events/*.yaml`.
 *
 * Intentionally NOT augmented by the package's own bundled
 * `events/generated/types.ts` — those fixtures stay local to the bundled
 * `TypedEventBus` so they never widen a consumer's `EventTypeName`.
 *
 * Must be an `interface` (only interfaces merge across module boundaries) and
 * empty by design — a consumer augments it via declaration merging.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DomainEventRegistry {}

/**
 * Union of registered event `type` literals. When the registry is augmented
 * (package-mode consumer with events) this is their event-type union; when it's
 * empty (the package itself, or a no-events project) it falls back to `string`
 * so the bridge/trigger types stay sound rather than collapsing to `never`.
 */
export type EventTypeName = keyof DomainEventRegistry extends never
  ? string
  : keyof DomainEventRegistry & string;

/**
 * The concrete event interface for a given `type`. Resolves to the consumer's
 * registered interface when the registry knows `T`; otherwise (the fallback
 * `string` case, or an unregistered literal) widens to the structural
 * `DomainEvent` base so `event.type` / `event.id` / `event.payload` are still
 * typed (payloads as `Record<string, unknown>`).
 */
export type EventOfType<T extends EventTypeName> =
  T extends keyof DomainEventRegistry ? DomainEventRegistry[T] : DomainEvent;
