/**
 * @pattern-stack/codegen-mail — public surface barrel.
 *
 * The L2 mail surface package: the canonical Email vocabulary, the
 * entity-agnostic `MailPort` composing contract, the capability descriptor, and
 * DI tokens. See ADR-036 (surface packages) and ../README.md.
 */

export * from './canonical';
export * from './capabilities';
export * from './mail.port';
export * from './tokens';

// Note: the conformance helper `assertMailAdapter` is intentionally NOT exported
// here — it ships from the '@pattern-stack/codegen-mail/testing' subpath so it
// stays out of production bundles.
