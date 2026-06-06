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
 * a `FieldMeta` object. Optional keys are present only when the field has them
 * (so the emitter can omit empty keys, matching the template's conditional
 * emission).
 *
 * The full YAML `ui_*` hint surface passes through (ADR-040): `group`,
 * `visible`, `placeholder`, `help`, and `format` come straight from the
 * author's YAML; `isKeyField`/`keyFieldOrder` carry key-field curation
 * (`ui_key_field` / `ui_key_field_order`) under the qField / EAV
 * `field_definitions` names so all three homes share one vocabulary.
 */
export interface DerivedFieldMeta {
	field: string; // camelCase property name
	label: string;
	type: FieldType;
	importance: FieldImportance;
	sortable: boolean;
	filterable: boolean;
	group?: string;
	visible?: boolean;
	placeholder?: string;
	help?: string;
	format?: Record<string, unknown>;
	choices?: string[];
	reference?: string; // FK target table (from foreign_key)
	isKeyField?: boolean;
	keyFieldOrder?: number;
}

/**
 * Derivation defaults a caller can supply from entity-level context (the
 * external-sync bundle in `emit-fields.ts` is the one current user). Author
 * YAML always wins over a default — these fill gaps, never override.
 */
export interface FieldMetaDefaults {
	group?: string;
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
 * names elsewhere). `choices` carries explicit enum choices.
 *
 * Authored `ui_*` hints pass through verbatim: `group` / `visible` /
 * `placeholder` / `help` / `format`. `defaults` fills entity-level derivation
 * defaults (currently `group`) only where the author left the hint unset.
 * `keyFieldOrder` is emitted only alongside `isKeyField: true` — an order
 * without curation is meaningless.
 */
export function deriveFieldMeta(
	field: ParsedField,
	defaults: FieldMetaDefaults = {},
): DerivedFieldMeta {
	const hasChoices = Array.isArray(field.choices) && field.choices.length > 0;
	const meta: DerivedFieldMeta = {
		field: CAMEL(field.name),
		label: field.ui.label ?? formatLabel(field.name),
		type: inferUiType(field),
		importance: inferUiImportance(field),
		sortable: field.ui.sortable ?? false,
		filterable: field.ui.filterable ?? false,
	};
	const group = field.ui.group ?? defaults.group;
	if (group !== undefined) meta.group = group;
	if (field.ui.visible !== undefined) meta.visible = field.ui.visible;
	if (field.ui.placeholder !== undefined) meta.placeholder = field.ui.placeholder;
	if (field.ui.help !== undefined) meta.help = field.ui.help;
	if (field.ui.format !== undefined) meta.format = field.ui.format;
	if (hasChoices) meta.choices = field.choices;
	if (field.foreignKey) meta.reference = field.foreignKey.table;
	if (field.ui.keyField) {
		meta.isKeyField = true;
		if (field.ui.keyFieldOrder !== undefined) {
			meta.keyFieldOrder = field.ui.keyFieldOrder;
		}
	}
	return meta;
}

// ============================================================================
// External-sync shape (family/behavior bundle, ADR-040)
// ============================================================================

/** Default `group` applied to external-sync bookkeeping fields. */
export const EXTERNAL_SYNC_GROUP = 'external_sync';

/**
 * The field names that make up the synced/integrated bookkeeping shape — the
 * columns the `external_id_tracking` behavior contributes when authors declare
 * them explicitly in YAML instead. `provider_metadata` rides along: it only
 * receives the default when the gate below detects the shape.
 */
export const EXTERNAL_SYNC_FIELDS: ReadonlySet<string> = new Set([
	'external_id',
	'provider',
	'provider_metadata',
]);

/**
 * Whether an entity's declared fields carry the synced/integrated shape:
 * BOTH `external_id` AND `provider` present. When true, the fields emitter
 * defaults `group: 'external_sync'` onto the `EXTERNAL_SYNC_FIELDS` rows
 * (a derivation default — an authored `ui_group` always wins).
 *
 * Conservative by design: this inspects only fields that exist in the parsed
 * map. Columns contributed by the `external_id_tracking` BEHAVIOR are not in
 * the parsed field map and therefore get no FieldMeta rows at all (same as
 * before ADR-040) — we never emit a row for a column we cannot see.
 */
export function hasExternalSyncShape(fieldNames: Iterable<string>): boolean {
	const names = new Set(fieldNames);
	return names.has('external_id') && names.has('provider');
}

// ============================================================================
// EAV data_type → FieldType contract (ADR-040)
// ============================================================================

/**
 * The EAV `field_definitions.data_type` vocabulary → frontend `FieldType`
 * rendering contract. This is the rallying point for external-system field
 * types: an EAV row's `data_type` maps through this table to the same
 * rendering vocabulary native columns use, so one renderer serves both.
 *
 * Notes:
 * - `picklist` AND `multipicklist` both map to `enum` — multi-select rendering
 *   is a consumer-side concern (the renderer checks the EAV row's cardinality,
 *   not the FieldType).
 * - `string` maps to `text`; EAV has no textarea heuristic (no `max_length`).
 *
 * The same constant is emitted into the generated `fields/field-meta.ts` (see
 * `buildFieldMetaTypeFile`) so consumer apps get it locally, rendered from
 * THIS object — the two cannot drift.
 */
export const EAV_DATA_TYPE_TO_FIELD_TYPE = {
	string: 'text',
	integer: 'number',
	decimal: 'number',
	boolean: 'boolean',
	date: 'date',
	datetime: 'datetime',
	json: 'json',
	reference: 'reference',
	picklist: 'enum',
	multipicklist: 'enum',
} as const satisfies Record<string, FieldType>;

/** The EAV `field_definitions.data_type` vocabulary. */
export type EavDataType = keyof typeof EAV_DATA_TYPE_TO_FIELD_TYPE;
