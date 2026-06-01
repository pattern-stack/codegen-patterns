/**
 * @pattern-stack/codegen-messaging — public surface barrel.
 *
 * The L2 messaging surface package: the canonical Channel/Message vocabulary, the
 * entity-agnostic `MessagingPort` composing contract (with its optional bot-user
 * `write` seam), the capability descriptor, and DI tokens. See ADR-036 (surface
 * packages), swe-brain ADR-0008 (MessagingDomain), and ../README.md.
 */

export * from './canonical';
export * from './capabilities';
export * from './messaging.port';
export * from './tokens';

// Note: the conformance helper `assertMessagingAdapter` is intentionally NOT
// exported here — it ships from the '@pattern-stack/codegen-messaging/testing'
// subpath so it stays out of production bundles.
