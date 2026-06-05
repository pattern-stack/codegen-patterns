/**
 * Frontend emitter — field UI-metadata derivation (ADR-038, FE-3).
 *
 * Ports the UI-inference helpers from the deleted `templates/entity/new/prompt.js`
 * (`inferUiType`, `inferUiImportance`, `formatLabel`, the entity_ref skip rules,
 * the choices/FK handling) into pure functions over `ParsedField`. The fields
 * emitter (`emit-fields.ts`) consumes these to build the `FieldMeta` objects the
 * old `fields.ejs.t` template emitted — same output contract.
 *
 * Naming for FK `reference` and belongs_to rows comes from the registry, never
 * re-pluralized here (the one place pts/prompt.js diverged; FE-1/FE-3 unify on
 * the registry).
 */

import type { ParsedField } from '../../analyzer/types';

/** UI field type vocabulary (matches the old `FieldType` union). */
export type FieldType =
	| 'text'
	| 'textarea'
	| 'number'
	| 'boolean'
	| 'date'
	| 'datetime'
	| 'email'
	| 'url'
	| 'password'
	| 'money'
	| 'percentage'
	| 'json'
	| 'enum'
	| 'reference'
	| 'entity';

/** UI importance tiers (matches the old `FieldImportance` union). */
export type FieldImportance = 'primary' | 'secondary' | 'tertiary';

/**
 * Derived UI metadata for one field — the shape the fields emitter renders into
 * a `FieldMeta` object. `choices`/`reference` are present only when the field
 * has them (so the emitter can omit empty keys, matching the template's
 * conditional emission).
 *
 * `format` is intentionally absent: the old template emitted `format` from a raw
 * `field.ui_format` that the parser does NOT carry onto `ParsedField` (only the
 * hardcoded timestamp `format: { dateFormat: 'relative' }` survives, emitted
 * directly by `emit-fields.ts`).
 */
export interface DerivedFieldMeta {
	field: string; // camelCase property name
	label: string;
	type: FieldType;
	importance: FieldImportance;
	sortable: boolean;
	filterable: boolean;
	choices?: string[];
	reference?: string; // FK target table (from foreign_key)
}

const CAMEL = (s: string): string =>
	s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Humanize a snake_case field name into a Title Case label
 * (`first_name` → `First Name`). Ported from prompt.js `formatLabel`.
 */
export function formatLabel(fieldName: string): string {
	return fieldName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Infer the UI type from a field. Explicit `ui.type` wins; then choices → enum,
 * FK → reference, name-pattern heuristics (email/url/password/money/percentage),
 * then the base-type map (string → text/textarea by max_length, etc).
 * Ported from prompt.js `inferUiType`.
 */
export function inferUiType(field: ParsedField): FieldType {
	if (field.ui.type) return field.ui.type as FieldType;

	if (Array.isArray(field.choices) && field.choices.length > 0) return 'enum';
	if (field.foreignKey) return 'reference';

	const nameLower = field.name.toLowerCase();
	if (nameLower.includes('email')) return 'email';
	if (nameLower.includes('url') || nameLower.includes('website')) return 'url';
	if (nameLower.includes('password')) return 'password';
	if (
		nameLower.includes('price') ||
		nameLower.includes('amount') ||
		nameLower.includes('cost') ||
		nameLower.includes('value') ||
		nameLower.includes('revenue')
	) {
		return 'money';
	}
	if (nameLower.includes('percent') || nameLower.includes('rate')) {
		return 'percentage';
	}

	switch (field.type) {
		case 'string':
			return field.constraints.maxLength && field.constraints.maxLength > 500
				? 'textarea'
				: 'text';
		case 'integer':
		case 'decimal':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'uuid':
			return 'text';
		case 'date':
			return 'date';
		case 'datetime':
			return 'datetime';
		case 'json':
			return 'json';
		default:
			return 'text';
	}
}

/**
 * Infer UI importance. Explicit `ui.importance` wins; then id/timestamps →
 * tertiary, FK `*_id` → secondary, required → primary, name/title → primary,
 * else secondary. Ported from prompt.js `inferUiImportance`.
 */
export function inferUiImportance(field: ParsedField): FieldImportance {
	if (field.ui.importance) return field.ui.importance as FieldImportance;

	const nameLower = field.name.toLowerCase();
	if (['id', 'created_at', 'updated_at', 'deleted_at'].includes(nameLower)) {
		return 'tertiary';
	}
	if (field.foreignKey && nameLower.endsWith('_id')) return 'secondary';
	if (field.required) return 'primary';
	if (nameLower.includes('name') || nameLower.includes('title')) return 'primary';
	return 'secondary';
}

/**
 * Whether a field is internal entity_ref machinery the metadata display skips
 * (the `isEntityRefType`/`isEntityRefId` skip in the old `fields.ejs.t`). The
 * parser emits these as `entity_ref` typed fields; in the generated DB the pair
 * surfaces as `<base>_entity_type` / `<base>_entity_id`. We skip both the base
 * `entity_ref` field and the derived `_entity_type` / `_entity_id` columns.
 */
export function isEntityRefField(field: ParsedField): boolean {
	if (field.type === 'entity_ref') return true;
	return field.name.endsWith('_entity_type') || field.name.endsWith('_entity_id');
}

/**
 * Derive the full UI metadata for one field. The `id` field is filtered by the
 * caller (the template skipped it); this returns metadata for any non-skipped
 * field. `reference` is the FK target table (the registry resolves display
 * names elsewhere). `choices` carries explicit enum choices; `format` passes
 * through `ui.format`.
 */
export function deriveFieldMeta(field: ParsedField): DerivedFieldMeta {
	const hasChoices = Array.isArray(field.choices) && field.choices.length > 0;
	const meta: DerivedFieldMeta = {
		field: CAMEL(field.name),
		label: field.ui.label ?? formatLabel(field.name),
		type: inferUiType(field),
		importance: inferUiImportance(field),
		sortable: field.ui.sortable ?? false,
		filterable: field.ui.filterable ?? false,
	};
	if (hasChoices) meta.choices = field.choices;
	if (field.foreignKey) meta.reference = field.foreignKey.table;
	return meta;
}
