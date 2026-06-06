/**
 * Frontend emitter — field metadata (ADR-038, FE-3).
 *
 * Port of the deleted `templates/entity/new/frontend/entity/fields.ejs.t` —
 * same output contract: a `fields/field-meta.ts` TYPE file (self-contained, so
 * the orphan `locations.frontendFieldMetaTypes` location is dead) plus a
 * per-entity `fields/<name>.ts` (`<camel>Fields` + `<camel>Metadata`) and a
 * `fields/index.ts` barrel.
 *
 * The metadata shape (primaryFields / searchFields / defaultSort / capabilities,
 * the timestamp rows, the belongs_to relation rows) matches the old template.
 * UI derivation lives in `field-meta.ts`; this module renders the derived shape.
 *
 * Capabilities rule (adapted from `exposeRepository || exposeTrpc`): the old
 * template gated create/update/delete on whether the entity exposed the
 * `repository` OR `trpc` layer. We read `expose` off the parsed entity (default
 * `['repository','rest','trpc']`) and set `create/update/delete` to
 * `expose.includes('repository') || expose.includes('trpc')`. `list`/`get` stay
 * always-true (read is never gated).
 *
 * Family/behavior common-field bundles (ADR-040), mirroring the timestamps
 * precedent (behavior-contributed columns exist in the generated table but not
 * in the parsed field map, so the emitter contributes their rows):
 * - `soft_delete` behavior ⇒ a `deletedAt` row (datetime / tertiary /
 *   `format: { dateFormat: 'relative' }`), exactly like createdAt/updatedAt.
 * - Entities whose DECLARED fields carry the synced/integrated shape (both
 *   `external_id` AND `provider` present) ⇒ those fields (plus
 *   `provider_metadata` when present) default to `group: 'external_sync'`.
 *   A derivation default only — an authored `ui_group` always wins. Columns
 *   contributed by the `external_id_tracking` BEHAVIOR are not in the parsed
 *   map and get no rows (we never emit a row for a column we cannot see).
 *
 * Key-field curation (ADR-040): `ui_key_field` / `ui_key_field_order` surface
 * as `isKeyField` / `keyFieldOrder` on the row, and the `<camel>Metadata`
 * object gains `keyFields` — the ordered curated field-name list (sorted by
 * `keyFieldOrder`, declaration order for ties / unordered) that drives
 * card/preview field selection in consumers.
 */

import { join } from 'node:path';
import type { ParsedEntity } from '../../analyzer/types';
import type { EntityRegistryEntry, FrontendEmitContext } from './types';
import { sortEntities } from './types';
import { withBanner, writeFile } from './emit-utils';
import {
	deriveFieldMeta,
	hasExternalSyncShape,
	isEntityRefField,
	EAV_DATA_TYPE_TO_FIELD_TYPE,
	EXTERNAL_SYNC_FIELDS,
	EXTERNAL_SYNC_GROUP,
	type DerivedFieldMeta,
} from './field-meta';
import { resolvableRels } from './emit-store';

const SOURCE_DESC_SET = 'the entity set';

/**
 * `fields/field-meta.ts` — the self-contained metadata module. Exactly the
 * properties the metadata objects use (`field`/`label`/`type`/`importance`,
 * the optional ui-hint surface, key-field curation) plus the EAV
 * `data_type` → `FieldType` rendering contract (`EAV_DATA_TYPE_TO_FIELD_TYPE`,
 * rendered from the source-of-truth constant in `field-meta.ts` so the
 * emitted copy cannot drift).
 */
export function buildFieldMetaTypeFile(): string {
	const eavKeys = Object.keys(EAV_DATA_TYPE_TO_FIELD_TYPE);
	const eavUnion = eavKeys.map((k) => `\t| '${k}'`).join('\n');
	const eavEntries = Object.entries(EAV_DATA_TYPE_TO_FIELD_TYPE)
		.map(([k, v]) => `\t${k}: '${v}',`)
		.join('\n');

	const body = `/**
 * Field metadata types for DataGrid, forms, and admin surfaces.
 */

export type FieldType =
\t| 'text'
\t| 'textarea'
\t| 'number'
\t| 'boolean'
\t| 'date'
\t| 'datetime'
\t| 'email'
\t| 'url'
\t| 'password'
\t| 'money'
\t| 'percentage'
\t| 'json'
\t| 'enum'
\t| 'reference'
\t| 'entity';

export type FieldImportance = 'primary' | 'secondary' | 'tertiary';

export interface FieldMeta<T = unknown> {
\t/** Property key on the entity (\`keyof T\` for typed access). */
\tfield: keyof T & string;
\tlabel: string;
\ttype: FieldType;
\timportance: FieldImportance;
\tsortable?: boolean;
\tfilterable?: boolean;
\t/** Layout grouping (e.g. 'external_sync'). */
\tgroup?: string;
\t/** \`false\` ⇒ hidden by default. Absent means visible. */
\tvisible?: boolean;
\tplaceholder?: string;
\t/** Help/description text shown alongside the field. */
\thelp?: string;
\tformat?: Record<string, unknown>;
\tchoices?: string[];
\treference?: string;
\t/** Curated/displayed field — drives card & preview field selection. */
\tisKeyField?: boolean;
\t/** Sort position within the key-field set. */
\tkeyFieldOrder?: number;
}

/** EAV \`field_definitions.data_type\` vocabulary. */
export type EavDataType =
${eavUnion};

/**
 * EAV \`field_definitions.data_type\` → \`FieldType\` rendering contract: an EAV
 * field renders through the same vocabulary as a native column. Note both
 * \`picklist\` and \`multipicklist\` map to \`enum\` — multi-select rendering is a
 * consumer-side concern (check the EAV row's cardinality, not the FieldType).
 */
export const EAV_DATA_TYPE_TO_FIELD_TYPE: Record<EavDataType, FieldType> = {
${eavEntries}
};
`;
	return withBanner(SOURCE_DESC_SET, body);
}

/** Whether the entity's behaviors include `timestamps`. */
function hasTimestamps(parsed: ParsedEntity | undefined): boolean {
	return parsed?.behaviors.includes('timestamps') ?? false;
}

/** Whether the entity's behaviors include `soft_delete`. */
function hasSoftDelete(parsed: ParsedEntity | undefined): boolean {
	return parsed?.behaviors.includes('soft_delete') ?? false;
}

/**
 * The displayable, derived field-meta list for an entity: every parsed field
 * except `id` and entity_ref internals, in parser order. When the declared
 * fields carry the external-sync shape (see `hasExternalSyncShape`), the
 * bookkeeping fields default to `group: 'external_sync'` — authored `ui_group`
 * wins.
 */
function displayFields(parsed: ParsedEntity | undefined): DerivedFieldMeta[] {
	if (!parsed) return [];
	const syncShape = hasExternalSyncShape(parsed.fields.keys());
	const out: DerivedFieldMeta[] = [];
	for (const field of parsed.fields.values()) {
		if (field.name === 'id') continue;
		if (isEntityRefField(field)) continue;
		const defaults =
			syncShape && EXTERNAL_SYNC_FIELDS.has(field.name)
				? { group: EXTERNAL_SYNC_GROUP }
				: undefined;
		out.push(deriveFieldMeta(field, defaults));
	}
	return out;
}

/** Escape a string for emission inside a single-quoted TS literal. */
function quote(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Render one `FieldMeta` object literal (omits absent optional keys). */
function renderFieldMeta(meta: DerivedFieldMeta): string {
	const lines = [
		`\t\tfield: '${meta.field}',`,
		`\t\tlabel: '${quote(meta.label)}',`,
		`\t\ttype: '${meta.type}' as FieldType,`,
		`\t\timportance: '${meta.importance}' as FieldImportance,`,
	];
	if (meta.sortable) lines.push('\t\tsortable: true,');
	if (meta.filterable) lines.push('\t\tfilterable: true,');
	if (meta.group !== undefined) lines.push(`\t\tgroup: '${quote(meta.group)}',`);
	if (meta.visible !== undefined) lines.push(`\t\tvisible: ${meta.visible},`);
	if (meta.placeholder !== undefined) {
		lines.push(`\t\tplaceholder: '${quote(meta.placeholder)}',`);
	}
	if (meta.help !== undefined) lines.push(`\t\thelp: '${quote(meta.help)}',`);
	if (meta.format !== undefined) {
		lines.push(`\t\tformat: ${JSON.stringify(meta.format)},`);
	}
	if (meta.choices) lines.push(`\t\tchoices: ${JSON.stringify(meta.choices)},`);
	if (meta.reference) lines.push(`\t\treference: '${meta.reference}',`);
	if (meta.isKeyField) {
		lines.push('\t\tisKeyField: true,');
		if (meta.keyFieldOrder !== undefined) {
			lines.push(`\t\tkeyFieldOrder: ${meta.keyFieldOrder},`);
		}
	}
	return `\t${meta.field}: {\n${lines.join('\n')}\n\t},`;
}

/** Title-case a PascalCase class name (`DealState` → `Deal State`). */
function humanizeClass(className: string): string {
	return className.replace(/([A-Z])/g, ' $1').trim();
}

/**
 * `fields/<name>.ts` — `<camel>Fields` (the FieldMeta map) + `<camel>Metadata`
 * (display config + capabilities). Same shape as the deleted template.
 */
export function buildEntityFieldsFile(
	entity: EntityRegistryEntry,
	ctx: FrontendEmitContext,
): string {
	const parsed = ctx.parsed.get(entity.name);
	const { camelName, className, classNamePlural, name, plural } = entity;

	const fields = displayFields(parsed);
	const rels = resolvableRels(entity, ctx);
	const ts = hasTimestamps(parsed);
	const sd = hasSoftDelete(parsed);

	// FieldMeta map entries: fields, then belongs_to relation rows, then the
	// behavior-contributed rows (timestamps, soft_delete).
	const fieldEntries = fields.map(renderFieldMeta);

	const relEntries = rels.map(
		(r) => `\t${r.propertyName}: {
\t\tfield: '${r.propertyName}',
\t\tlabel: '${humanizeClass(r.target.className)}',
\t\ttype: 'entity' as FieldType,
\t\timportance: 'secondary' as FieldImportance,
\t\treference: '${r.target.plural}',
\t},`,
	);

	const tsEntries = ts
		? [
				`\tcreatedAt: {
\t\tfield: 'createdAt',
\t\tlabel: 'Created',
\t\ttype: 'datetime' as FieldType,
\t\timportance: 'tertiary' as FieldImportance,
\t\tformat: { dateFormat: 'relative' },
\t},`,
				`\tupdatedAt: {
\t\tfield: 'updatedAt',
\t\tlabel: 'Updated',
\t\ttype: 'datetime' as FieldType,
\t\timportance: 'tertiary' as FieldImportance,
\t\tformat: { dateFormat: 'relative' },
\t},`,
			]
		: [];

	// soft_delete behavior contributes a deleted_at column — same precedent as
	// the timestamps rows above (column exists in the generated table, not in
	// the parsed field map, so the emitter contributes the row).
	const sdEntries = sd
		? [
				`\tdeletedAt: {
\t\tfield: 'deletedAt',
\t\tlabel: 'Deleted',
\t\ttype: 'datetime' as FieldType,
\t\timportance: 'tertiary' as FieldImportance,
\t\tformat: { dateFormat: 'relative' },
\t},`,
			]
		: [];

	const allEntries = [...fieldEntries, ...relEntries, ...tsEntries, ...sdEntries].join(
		'\n',
	);

	const primaryFields = fields
		.filter((f) => f.importance === 'primary')
		.map((f) => `\t\t'${f.field}',`)
		.join('\n');
	// Key-field curation (ADR-040): ordered by keyFieldOrder, declaration order
	// for ties / unordered (stable sort). Only YAML-declared fields participate.
	const keyFields = fields
		.filter((f) => f.isKeyField)
		.sort(
			(a, b) =>
				(a.keyFieldOrder ?? Number.MAX_SAFE_INTEGER) -
				(b.keyFieldOrder ?? Number.MAX_SAFE_INTEGER),
		)
		.map((f) => `\t\t'${f.field}',`)
		.join('\n');
	const searchFields = fields
		.filter((f) => f.filterable)
		.map((f) => `\t\t'${f.field}',`)
		.join('\n');

	const defaultSortField = ts ? 'createdAt' : 'id';

	// Capabilities: write gated on repository|trpc exposure (default-on).
	const expose = parsed?.expose ?? ['repository', 'rest', 'trpc'];
	const canWrite = expose.includes('repository') || expose.includes('trpc');

	const body = `import type { FieldMeta, FieldType, FieldImportance } from './field-meta';
import type { ${className} } from '${ctx.config.dbEntitiesImport}/${name}';

export const ${camelName}Fields: Record<string, FieldMeta<${className}>> = {
${allEntries}
};

export const ${camelName}Metadata = {
\tname: '${name}',
\tplural: '${plural}',
\tdisplayName: '${humanizeClass(className)}',
\tdisplayNamePlural: '${humanizeClass(classNamePlural)}',

\tfields: ${camelName}Fields,

\tprimaryFields: [
${primaryFields}
\t],
\tkeyFields: [
${keyFields}
\t],
\tsearchFields: [
${searchFields}
\t],
\tdefaultSort: { field: '${defaultSortField}', direction: 'desc' as const },

\tcapabilities: {
\t\tcreate: ${canWrite},
\t\tupdate: ${canWrite},
\t\tdelete: ${canWrite},
\t\tlist: true,
\t\tget: true,
\t},
} as const;
`;
	return withBanner(`entities/${name}.yaml`, body);
}

/** `fields/index.ts` — `export * from './<name>'` per entity, sorted. */
export function buildFieldsIndexFile(ctx: FrontendEmitContext): string {
	const entities = sortEntities(ctx.entities);
	const lines = entities.map((e) => `export * from './${e.name}';`);
	return withBanner(SOURCE_DESC_SET, `${lines.join('\n')}\n`);
}

/**
 * Emit `fields/field-meta.ts`, `fields/<name>.ts` (sorted), and
 * `fields/index.ts` into `<outDir>/fields`. Returns written paths.
 */
export function emitFields(ctx: FrontendEmitContext, outDir: string): string[] {
	const fieldsDir = join(outDir, 'fields');
	const entities = sortEntities(ctx.entities);
	const written: string[] = [];

	const typePath = join(fieldsDir, 'field-meta.ts');
	writeFile(typePath, buildFieldMetaTypeFile());
	written.push(typePath);

	for (const entity of entities) {
		const filePath = join(fieldsDir, `${entity.name}.ts`);
		writeFile(filePath, buildEntityFieldsFile(entity, ctx));
		written.push(filePath);
	}

	const indexPath = join(fieldsDir, 'index.ts');
	writeFile(indexPath, buildFieldsIndexFile(ctx));
	written.push(indexPath);

	return written;
}
