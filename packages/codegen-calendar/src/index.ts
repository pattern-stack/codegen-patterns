/**
 * @pattern-stack/codegen-calendar — public surface barrel.
 *
 * The L2 calendar surface package: the canonical Meeting vocabulary, the
 * entity-agnostic `CalendarPort` composing contract, the capability descriptor,
 * and DI tokens. See ADR-036 (surface packages) and ../README.md.
 */

export * from './canonical';
export * from './capabilities';
export * from './calendar.port';
export * from './tokens';

// Note: the conformance helper `assertCalendarAdapter` is intentionally NOT
// exported here — it ships from the '@pattern-stack/codegen-calendar/testing'
// subpath so it stays out of production bundles.
