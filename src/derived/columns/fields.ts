/**
 * `deriveFieldFacts` — a declared field map as {@link FieldFacts}, the one place a field's column facts are worked out
 * (TGT-0). Pure: no Drizzle, no Zod, no source text. Every target renders from these facts.
 *
 * Hygen-safe: `entity-locals.js` and the junction prompt import this module, so it imports only modules that ship in
 * the package's `files` (ADR-046 § Consequences).
 */

import { camelCase } from '../../config/file-naming.js';
import { stringLengthBounds } from '../../schema/field-length.js';
import { fieldColumnNullable, hasColumnDefault } from '../../schema/field-nullability.js';
import { fieldWithTimezone } from '../../schema/field-timestamp.js';
import { enumTypeNames } from '../api/names.js';
import type { EnumResolver, FieldFacts } from './types.js';

/**
 * Array field types → their ELEMENT type (#281). An array field is its element type wrapped once, in every
 * vocabulary a target renders. With `choices:` the element is the enum, so `string_array` + `choices` is an enum
 * ARRAY — never a single enum column (F4).
 */
const ARRAY_ELEMENT_TYPE: Readonly<Record<string, string>> = {
	string_array: 'string',
};

/** True when `type` is an array field type. */
export function isArrayType(type: string): boolean {
	return Object.prototype.hasOwnProperty.call(ARRAY_ELEMENT_TYPE, type);
}

/** The element type of an array type; the type itself otherwise. */
export function arrayElementType(type: string): string {
	return ARRAY_ELEMENT_TYPE[type] ?? type;
}

/** The keys of a declared field this derivation reads. Validation (`FieldDefinitionSchema`) has already run. */
type DeclaredField = Readonly<Record<string, unknown>> & {
	type?: string;
	required?: boolean;
	default?: unknown;
	example?: unknown;
	choices?: readonly string[];
	choices_of?: string;
	timezone?: boolean;
	min_length?: unknown;
	max_length?: unknown;
};

/**
 * The facts of every declared field but `id`, in declaration order.
 *
 * `entityName` (snake_case) namespaces an enum field's names, so two entities that each declare an enum field with
 * the SAME name (e.g. `role`, `status`) do not collide: `field_config_role` / `fieldConfigRoleEnum`, never a second
 * `role` / `roleEnum` (`enumTypeNames`). `enumResolver` resolves a `choices_of:` field to its owner's enum; without
 * one, a `choices_of:` field is read from its own keys (the junction payload, which has no lookup).
 */
export function deriveFieldFacts(
	fields: Readonly<Record<string, DeclaredField>>,
	entityName: string,
	enumResolver: EnumResolver | null,
): FieldFacts[] {
	const facts: FieldFacts[] = [];
	for (const [fieldName, field] of Object.entries(fields)) {
		if (fieldName === 'id') continue;

		const type = field.type || 'string';
		// `choices_of: <entity>.<field>` (RFC-0006 §2.4): the column is typed with ANOTHER entity's enum, which the
		// entity imports and never redeclares.
		const imported = field.choices_of !== undefined && enumResolver ? enumResolver(fieldName, field) : null;
		const choices = imported ? imported.choices : field.choices;
		const hasChoices = Array.isArray(choices) && choices.length > 0;
		const own = hasChoices && !imported ? enumTypeNames(entityName, fieldName) : null;
		const { minLength, maxLength } = stringLengthBounds(field, type, hasChoices);

		facts.push({
			name: fieldName,
			camelName: camelCase(fieldName),
			type,
			elementType: arrayElementType(type),
			isArray: isArrayType(type),
			nullable: fieldColumnNullable(field),
			required: field.required ?? false,
			hasDefault: hasColumnDefault(field),
			default: field.default,
			example: field.example,
			withTimezone: field.type === 'datetime' ? fieldWithTimezone(field) : null,
			choices,
			hasChoices,
			enumName: hasChoices ? (imported ? imported.enumName : own!.enumName) : null,
			enumDbName: hasChoices ? (imported ? imported.dbName : own!.dbName) : null,
			enumImport: imported ? { enumName: imported.enumName, importPath: imported.importPath } : null,
			minLength,
			maxLength,
		});
	}
	return facts;
}
