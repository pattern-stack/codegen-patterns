/**
 * Transcript surface package — DI tokens.
 *
 * The transcript surface has no L2 sub-ports, so it ships only the two tokens
 * every surface needs: its capability descriptor and the composed port. The L1
 * seams a `TranscriptPort` injects (`auth`, the entity-keyed change-source
 * registry) bind under the codegen subsystems' own tokens (`STRATEGY_REGISTRY`,
 * `ENTITY_CHANGE_SOURCE_REGISTRY`), not here.
 *
 * `Symbol.for(...)` matches a token by key across duplicated module instances /
 * import boundaries — the case a published, possibly-deduped surface package
 * needs (mirrors `@pattern-stack/codegen-crm`).
 */

/** DI token for an adapter's `TranscriptCapabilities` descriptor. */
export const TRANSCRIPT_CAPABILITIES = Symbol.for(
  '@pattern-stack/codegen-transcript.capabilities',
);

/** DI token for the composed `TranscriptPort` adapter. */
export const TRANSCRIPT_PORT = Symbol.for(
  '@pattern-stack/codegen-transcript.port',
);
