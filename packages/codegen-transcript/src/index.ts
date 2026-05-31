/**
 * @pattern-stack/codegen-transcript — public surface barrel.
 *
 * The L2 transcript surface package: the canonical Transcript vocabulary
 * (including `TranscriptSegment`), the entity-agnostic `TranscriptPort`
 * composing contract, the capability descriptor, and DI tokens. See ADR-036
 * (surface packages) and ../README.md.
 */

export * from './canonical';
export * from './capabilities';
export * from './ports/transcript.port';
export * from './tokens';

// Note: the conformance helper `assertTranscriptAdapter` is intentionally NOT
// exported here — it ships from the '@pattern-stack/codegen-transcript/testing'
// subpath so it stays out of production bundles.
