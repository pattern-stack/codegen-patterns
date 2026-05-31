/**
 * @pattern-stack/codegen-crm — public surface barrel.
 *
 * The L2 CRM surface package: type-shaped ports + DI tokens that the generated
 * L3 `CrmPort` composes. See ADR-036 (surface packages) and ../README.md.
 */

export * from './ports/field-definition-reader.port';
export * from './ports/picklist-reader.port';
export * from './ports/association-reader.port';
export * from './ports/crm.port';
export * from './capabilities';
export * from './tokens';

// Note: the conformance helper `assertCrmAdapter` is intentionally NOT exported
// here — it ships from the '@pattern-stack/codegen-crm/testing' subpath so it
// stays out of production bundles.
