/**
 * @pattern-stack/codegen-crm — public surface barrel.
 *
 * The L2 CRM surface package: type-shaped ports + DI tokens that the generated
 * L3 `CrmPort` composes. See ADR-036 (surface packages) and ../README.md.
 */

export * from './ports/field-definition-reader.port';
export * from './tokens';
