---
to: "<%= outputPaths.entity %>"
force: true
---
<%- generatedBanner %>
import {
<%_ drizzleImports.forEach(i => { _%>
  <%= i %>,
<%_ }) _%>
<%_ if (hasFk) { _%>
  type AnyPgColumn,
<%_ } _%>
} from 'drizzle-orm/pg-core';
import { <%- drizzleOrmImports.map(i => i + ', ').join('') %>type InferSelectModel } from 'drizzle-orm';
<%_ belongsToTableImports.forEach(imp => { _%>
import { <%- [imp.relatedTable, ...(imp.extraNames || [])].join(', ') %> } from '<%= imp.importPath %>';
<%_ }) _%>
<%_ /* #354: field-level foreign_key target table imports */ _%>
<%_ fieldFkImports.forEach(imp => { _%>
import { <%= imp.relatedTable %> } from '<%= imp.importPath %>';
<%_ }) _%>
<%_ inheritanceImports.forEach(imp => { _%>
import { <%- imp.names.join(', ') %> } from '<%= imp.importPath %>';
<%_ }) _%>
<%_ if (enumFields.length > 0) { _%>
<%_ /* The pgEnum declarations live in a leaf module that imports only pg-core, so another entity can import an enum without an import cycle. Re-exported: the schema barrel and drizzle-kit read this file. */ _%>
import { <%- enumFields.map(ef => ef.enumName).join(', ') %> } from '<%= enumsImportSpecifier %>';

export { <%- enumFields.map(ef => ef.enumName).join(', ') %> };
<%_ } _%>

export const <%= entityNamePlural %> = pgTable(
  '<%= entityTableName %>',
  {
<%_ if (isInheritanceChild) { _%>
    id: uuid('id').primaryKey(), // the base row supplies it: a primary key that is also a foreign key
<%_ inheritedKeyColumns.forEach(c => { _%>
    <%- c.line %>,
<%_ }) _%>
<%_ } else { _%>
    id: uuid('id').primaryKey().defaultRandom(),
<%_ } _%>
<%_ belongsTo.forEach(rel => { _%>
<%_ if (hasSoftDelete) { _%>
    // WARNING: on_delete: '<%= rel.onDeleteYaml %>' is a no-op when this entity uses soft_delete.
    // BaseService.delete() issues UPDATE … SET deleted_at = now(), not DELETE, so Postgres
    // cascade rules never fire for a soft-deleted parent. This FK constraint only applies on
    // hard-delete (e.g. admin purge). See ADR-021: docs/adrs/ADR-021-on-delete-semantics.md
<%_ } _%>
<%_ if (rel.match) { _%>
    // match: this column is half of a composite FK (see the constraints below), not a single-column reference.
    <%= rel.camelField %>: uuid('<%= rel.field %>')<%= rel.nullable ? '' : '.notNull()' %>,
<%_ } else { _%>
    <%= rel.camelField %>: uuid('<%= rel.field %>')<%= rel.nullable ? '' : '.notNull()' %>.references((): AnyPgColumn => <%= rel.relatedTable %>.id, { onDelete: '<%= rel.onDelete %>' }),
<%_ } _%>
<%_ }) _%>
<%_ matchDerivedColumns.forEach(c => { _%>
    // match: derived from the target column; never client input, filled by the insert (RFC-0006 §2.4)
    <%- c.line %>,
<%_ }) _%>
<%_ processedFields.forEach(field => { _%>
    <%= field.camelName %>: <%- field.drizzleChain %>,
<%_ }) _%>
<%_ if (ownsExternalIdColumns) { _%>
    // external_id_tracking behavior
    externalId: varchar('external_id'),
    provider: varchar('provider'),
    providerMetadata: jsonb('provider_metadata'),
<%_ } _%>
<%_ if (tenantColumnEmitted) { _%>
    // tenant_scoped (ADR-042). NULLABLE on purpose: flipping the flag on an
    // existing table is then an additive ADD COLUMN, and the host tightens it
    // to NOT NULL after backfilling. No .references() — the tenants table is
    // host-owned, and codegen emits a DB-level FK only for tables it generates
    // (#636).
    <%= tenantColumnProp %>: uuid('<%= tenantColumnName %>'),
<%_ } _%>
<%_ if (hasTimestamps) { _%>
    createdAt: <%- timestampColumn('created_at', timestampsWithTimezone) %>.notNull().defaultNow(),
    updatedAt: <%- timestampColumn('updated_at', timestampsWithTimezone) %>.notNull().defaultNow(),
<%_ } _%>
<%_ if (hasSoftDelete) { _%>
    deletedAt: <%- timestampColumn('deleted_at', softDeleteWithTimezone) %>,
<%_ } _%>
  },
<%_ /* #355/#356/#511/#784: pgTable extra-config — indexes + unique constraints (uniqueIndex / unique().nullsNotDistinct()) + external_id unique */ _%>
<%_ if (tableConstraints.length > 0) { _%>
  (<%= tableCallbackParam %>) => [
<%_ tableConstraints.forEach(c => { _%>
<%_ if (c.comment) { _%>
    // <%= c.comment %>
<%_ } _%>
    <%- c.expr %>,
<%_ }) _%>
  ],
<%_ } _%>
);

export type <%= classNames.entity %> = InferSelectModel<typeof <%= entityNamePlural %>>;
export type <%= classNames.entity %>Insert = typeof <%= entityNamePlural %>.$inferInsert;
