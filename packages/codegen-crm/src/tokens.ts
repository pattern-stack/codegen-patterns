/**
 * CRM surface package — DI tokens (Track C · C1, #330).
 *
 * One token per CRM L2 port. Consumers bind their reader implementations to
 * these in their NestJS module; the generated L3 `CrmPort` (C6) injects them.
 *
 * `Symbol.for(...)` (the global symbol registry) is used so a token matches by
 * key across duplicated module instances / import boundaries — important for a
 * published package that may be deduped or doubly-installed in a consumer tree.
 * This package establishes its own token convention (it is the first surface
 * package); the integration *subsystem* uses string tokens for its own
 * documented reasons, but a standalone published surface package is the case
 * `Symbol.for` is designed for.
 */

/** DI token for the CRM `IFieldDefinitionReader` (C1). */
export const CRM_FIELD_DEFINITION_READER = Symbol.for(
  '@pattern-stack/codegen-crm.field-definition-reader',
);
