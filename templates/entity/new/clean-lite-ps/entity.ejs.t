---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.entity : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import {
<%_ clpDrizzleImports.filter(i => i !== 'relations').forEach(i => { _%>
  <%= i %>,
<%_ }) _%>
<%_ if (typeof clpHasSelfFk !== 'undefined' && clpHasSelfFk) { _%>
  type AnyPgColumn,
<%_ } _%>
} from 'drizzle-orm/pg-core';
<%_ if (clpHasRelationsBlock) { _%>
import { relations, type InferSelectModel } from 'drizzle-orm';
<%_ } else { _%>
import { type InferSelectModel } from 'drizzle-orm';
<%_ } _%>
<%_ clpBelongsTo.forEach(rel => { _%>
<%_ if (rel.relatedTable !== entityNamePlural) { _%>
import { <%= rel.relatedTable %> } from '<%= rel.importPath %>';
<%_ } _%>
<%_ }) _%>
<%_ if (typeof clpEnumFields !== 'undefined' && clpEnumFields.length > 0) { _%>

<%_ clpEnumFields.forEach(ef => { _%>
export const <%= ef.enumName %> = pgEnum('<%= ef.dbName %>', [<%- ef.choices.map(c => `'${c}'`).join(', ') %>]);
<%_ }) _%>
<%_ } _%>

export const <%= entityNamePlural %> = pgTable(
  '<%= entityNamePlural %>',
  {
    id: uuid('id').primaryKey().defaultRandom(),
<%_ clpBelongsTo.forEach(rel => { _%>
<%_ if (hasSoftDelete) { _%>
    // WARNING: on_delete: '<%= rel.onDeleteYaml %>' is a no-op when this entity uses soft_delete.
    // BaseService.delete() issues UPDATE … SET deleted_at = now(), not DELETE, so Postgres
    // cascade rules never fire for a soft-deleted parent. This FK constraint only applies on
    // hard-delete (e.g. admin purge). See ADR-021: docs/adrs/ADR-021-on-delete-semantics.md
<%_ } _%>
    <%= rel.camelField %>: uuid('<%= rel.field %>')<%= rel.nullable ? '' : '.notNull()' %>.references(<%= rel.isSelfFk ? '(): AnyPgColumn ' : '() ' %>=> <%= rel.relatedTable %>.id, { onDelete: '<%= rel.onDelete %>' }),
<%_ }) _%>
<%_ clpProcessedFields.forEach(field => { _%>
    <%= field.camelName %>: <%- field.drizzleChain %>,
<%_ }) _%>
<%_ if (hasExternalIdTracking) { _%>
    // external_id_tracking behavior
    externalId: varchar('external_id'),
    provider: varchar('provider'),
    providerMetadata: jsonb('provider_metadata'),
<%_ } _%>
<%_ if (hasTimestamps) { _%>
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
<%_ } _%>
<%_ if (hasSoftDelete) { _%>
    deletedAt: timestamp('deleted_at'),
<%_ } _%>
  },
);
<%_ if (clpHasRelationsBlock) { _%>

export const <%= entityNamePlural %>Relations = relations(<%= entityNamePlural %>, ({ one }) => ({
<%_ clpBelongsTo.forEach(rel => { _%>
  <%= rel.relationKey %>: one(<%= rel.relatedTable %>, {
    fields: [<%= entityNamePlural %>.<%= rel.camelField %>],
    references: [<%= rel.relatedTable %>.id],
  }),
<%_ }) _%>
}));
<%_ } _%>

export type <%= classNames.entity %> = InferSelectModel<typeof <%= entityNamePlural %>>;
export type <%= classNames.entity %>Insert = typeof <%= entityNamePlural %>.$inferInsert;
