/**
 * Entity and relationship names that cannot be generated (#813).
 *
 * An entity's PascalCase name is emitted as a *type* (`export type Date = …`) in
 * every file that reads the entity. That binding shadows the lib global of the
 * same name for the whole file. Emitted code writes every other lib type as
 * `globalThis.<Name>`, but `Promise`, `Array` and `Date` appear in nearly every
 * emitted signature, so they are written bare, and an entity may not take them.
 *
 * `test/_emitted-name-hygiene.ts` allows exactly this list unqualified, so a
 * template that writes another bare lib type fails the lint until it is either
 * qualified or added here.
 *
 * Shipped with the package: imports nothing.
 */

/** A lib global that emitted code writes unqualified, so no entity may take its name. */
export interface ReservedTypeName {
  /** The TypeScript global, e.g. 'Date'. Always one PascalCase word (asserted by test). */
  readonly global: string;
  /** Completes "…which generated code ___." */
  readonly usedFor: string;
}

export const RESERVED_ENTITY_TYPE_NAMES: readonly ReservedTypeName[] = [
  { global: 'Promise', usedFor: 'uses in every async method signature' },
  { global: 'Array', usedFor: 'uses for every list result' },
  { global: 'Date', usedFor: 'uses for every date and timestamp column' },
];

/** The emitted type name for a snake_case definition name (same rule as entity-locals.js). */
export function generatedTypeName(snakeName: string): string {
  const camel = snakeName.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** The reserved global this name would shadow, or null. */
export function reservedGlobalFor(snakeName: string): ReservedTypeName | null {
  const type = generatedTypeName(snakeName);
  return RESERVED_ENTITY_TYPE_NAMES.find((r) => r.global === type) ?? null;
}

export function reservedNameMessage(
  kind: 'Entity' | 'Relationship',
  name: string,
  reserved: ReservedTypeName,
): string {
  return (
    `${kind} name '${name}' is reserved: its generated type '${reserved.global}' would shadow ` +
    `the TypeScript global '${reserved.global}', which generated code ${reserved.usedFor}. ` +
    `Rename the ${kind.toLowerCase()}.`
  );
}
