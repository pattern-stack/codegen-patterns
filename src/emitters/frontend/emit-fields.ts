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
 */

import { join } from 'node:path';
import type { ParsedEntity } from '../../analyzer/types';
import type { EntityRegistryEntry, FrontendEmitContext } from './types';
import { sortEntities } from './types';
import { withBanner, writeFile } from './emit-utils';
import {
	deriveFieldMeta,
	isEntityRefField,
	type DerivedFieldMeta,
} from './field-meta';
import { resolvableRels } from './emit-store';

const SOURCE_DESC_SET = 'the entity set';

/**
 * `fields/field-meta.ts` — the self-contained metadata TYPE file. Exactly the
 * properties the metadata objects use (`field`/`label`/`type`/`importance`,
 * optional `sortable`/`filterable`/`format`/`choices`/`reference`).
 */
export function buildFieldMetaTypeFile(): string {
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
\tformat?: Record<string, unknown>;
\tchoices?: string[];
\treference?: string;
}
`;
	return withBanner(SOURCE_DESC_SET, body);
}

/** Whether the entity's behaviors include `timestamps`. */
function hasTimestamps(parsed: ParsedEntity | undefined): boolean {
	return parsed?.behaviors.includes('timestamps') ?? false;
}

/**
 * The displayable, derived field-meta list for an entity: every parsed field
 * except `id` and entity_ref internals, in parser order.
 */
function displayFields(parsed: ParsedEntity | undefined): DerivedFieldMeta[] {
	if (!parsed) return [];
	const out: DerivedFieldMeta[] = [];
	for (const field of parsed.fields.values()) {
		if (field.name === 'id') continue;
		if (isEntityRefField(field)) continue;
		out.push(deriveFieldMeta(field));
	}
	return out;
}

/** Render one `FieldMeta` object literal (omits absent optional keys). */
function renderFieldMeta(meta: DerivedFieldMeta): string {
	const lines = [
		`\t\tfield: '${meta.field}',`,
		`\t\tlabel: '${meta.label}',`,
		`\t\ttype: '${meta.type}' as FieldType,`,
		`\t\timportance: '${meta.importance}' as FieldImportance,`,
	];
	if (meta.sortable) lines.push('\t\tsortable: true,');
	if (meta.filterable) lines.push('\t\tfilterable: true,');
	if (meta.choices) lines.push(`\t\tchoices: ${JSON.stringify(meta.choices)},`);
	if (meta.reference) lines.push(`\t\treference: '${meta.reference}',`);
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

	// FieldMeta map entries: fields, then belongs_to relation rows, then ts rows.
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

	const allEntries = [...fieldEntries, ...relEntries, ...tsEntries].join('\n');

	const primaryFields = fields
		.filter((f) => f.importance === 'primary')
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
