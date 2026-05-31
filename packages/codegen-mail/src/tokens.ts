/**
 * Mail surface package — DI tokens.
 *
 * The mail surface has no L2 sub-ports, so it ships only the two tokens every
 * surface needs: its capability descriptor and the composed port. The L1 seams a
 * `MailPort` injects (`auth`, the entity-keyed change-source registry) bind under
 * the codegen subsystems' own tokens (`STRATEGY_REGISTRY`,
 * `ENTITY_CHANGE_SOURCE_REGISTRY`), not here.
 *
 * `Symbol.for(...)` matches a token by key across duplicated module instances /
 * import boundaries — the case a published, possibly-deduped surface package
 * needs (mirrors `@pattern-stack/codegen-crm`).
 */

/** DI token for an adapter's `MailCapabilities` descriptor. */
export const MAIL_CAPABILITIES = Symbol.for(
  '@pattern-stack/codegen-mail.capabilities',
);

/** DI token for the composed `MailPort` adapter. */
export const MAIL_PORT = Symbol.for('@pattern-stack/codegen-mail.port');
