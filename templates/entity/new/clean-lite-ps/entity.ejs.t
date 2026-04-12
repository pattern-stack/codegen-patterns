---
to: "<%= typeof clpOutputPaths !== 'undefined' ? clpOutputPaths.entity : null %>"
skip_if: "<%= typeof clpOutputPaths === 'undefined' %>"
force: true
---
import {
<%_ clpDrizzleImports.filter(i => i !== 'relations').forEach(i => { _%>
  <%= i %>,
<%_ }) _%>
} from 'drizzle-orm/pg-core';
<%_ if (clpHasRelationsBlock) { _%>
import { relations, type InferSelectModel } from 'drizzle-orm';
<%_ } else { _%>
import { type InferSelectModel } from 'drizzle-orm';
<%_ } _%>
<%_ clpBelongsTo.forEach(rel => { _%>
import { <%= rel.relatedTable %> } from '<%= rel.importPath %>';
<%_ }) _%>

export const <%= entityNamePlural %> = pgTable(
  '<%= entityNamePlural %>',
  {
    id: uuid('id').primaryKey().defaultRandom(),
<%_ clpBelongsTo.forEach(rel => { _%>
    <%= rel.camelField %>: uuid('<%= rel.field %>')<%= rel.nullable ? '' : '.notNull()' %>,
<%_ }) _%>
<%_ clpProcessedFields.forEach(field => { _%>
    <%= field.camelName %>: <%- field.drizzleChain %>,
<%_ }) _%>
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
  <%= rel.relatedEntity %>: one(<%= rel.relatedTable %>, {
    fields: [<%= entityNamePlural %>.<%= rel.camelField %>],
    references: [<%= rel.relatedTable %>.id],
  }),
<%_ }) _%>
}));
<%_ } _%>

export type <%= classNames.entity %> = InferSelectModel<typeof <%= entityNamePlural %>>;
export type <%= classNames.entity %>Insert = typeof <%= entityNamePlural %>.$inferInsert;
