/**
 * Messaging surface package — DI tokens.
 *
 * The messaging surface has no L2 sub-ports, so it ships the two tokens every
 * surface needs — its capability descriptor and the composed port — plus
 * `MESSAGE_WRITE` for the bot-user write capability (ADR-0008 §9), which is a
 * distinct injectable even though it ships dark in v1. The L1 seams a
 * `MessagingPort` injects (`auth`, the entity-keyed change-source registry) bind
 * under the codegen subsystems' own tokens (`STRATEGY_REGISTRY`,
 * `ENTITY_CHANGE_SOURCE_REGISTRY`), not here.
 *
 * `Symbol.for(...)` matches a token by key across duplicated module instances /
 * import boundaries — the case a published, possibly-deduped surface package
 * needs (mirrors `@pattern-stack/codegen-transcript`).
 */

/** DI token for an adapter's `MessagingCapabilities` descriptor. */
export const MESSAGING_CAPABILITIES = Symbol.for(
  '@pattern-stack/codegen-messaging.capabilities',
);

/** DI token for the composed `MessagingPort` adapter. */
export const MESSAGING_PORT = Symbol.for(
  '@pattern-stack/codegen-messaging.port',
);

/** DI token for the bot-user `MessageWrite` capability (ships dark in v1; ADR-0008 §9). */
export const MESSAGE_WRITE = Symbol.for(
  '@pattern-stack/codegen-messaging.message-write',
);
