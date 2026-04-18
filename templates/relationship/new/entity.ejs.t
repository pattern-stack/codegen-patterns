---
to: "<%= outputPaths.entity %>"
force: true
---
import {
<%_ drizzleImports.filter(i => i !== 'relations').forEach(i => { _%>
  <%= i %>,
<%_ }) _%>
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { <%= fromTable %> } from '../<%= fromTable %>/<%= from %>.entity';
<%_ if (from !== to) { _%>
import { <%= toTable %> } from '../<%= toTable %>/<%= to %>.entity';
<%_ } _%>

// ============================================================================
// Enums
// ============================================================================
<%_ if (hasTypes) { _%>

export const <%= typeEnumName %> = pgEnum('<%= name %>_type', [
<%_ typeEnumValues.forEach(t => { _%>
  '<%= t %>',
<%_ }) _%>
]);
<%_ } _%>
<%_ if (sourced) { _%>

export const <%= sourceEnumName %> = pgEnum('<%= name %>_source', [
<%_ sourceEnumValues.forEach(s => { _%>
  '<%= s %>',
<%_ }) _%>
]);
<%_ } _%>
<%_ enumFields.forEach(field => { _%>

export const <%= field.enumName %> = pgEnum('<%= name %>_<%= field.name %>', [
<%_ field.choices.forEach(c => { _%>
  '<%= c %>',
<%_ }) _%>
]);
<%_ }) _%>

// ============================================================================
// Table
// ============================================================================

export const <%= tableVarName %> = pgTable(
  '<%= tableName %>',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // FK columns (auto-generated from relationship endpoints)
    <%= fromColumnCamel %>: uuid('<%= fromColumn %>').notNull().references(() => <%= fromTable %>.id, { onDelete: '<%= onDeleteFromSql %>' }),
    <%= toColumnCamel %>: uuid('<%= toColumn %>').notNull().references(() => <%= toTable %>.id, { onDelete: '<%= onDeleteToSql %>' }),
<%_ if (hasTypes) { _%>

    // Type taxonomy
    type: <%= typeEnumName %>('type').notNull(),
<%_ } _%>
<%_ if (temporal) { _%>

    // Temporal validity
    validFrom: date('valid_from'),
    validTo: date('valid_to'),
    isCurrent: boolean('is_current').default(true),
<%_ } _%>
<%_ if (sourced) { _%>

    // Source tracking
    source: <%= sourceEnumName %>('source'),
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
<%_ } _%>
<%_ if (processedFields.length > 0) { _%>

    // Custom fields
<%_ processedFields.forEach(field => { _%>
<%_ if (field.hasChoices) { _%>
    <%= field.camelName %>: <%= field.enumName %>('<%= field.name %>'),
<%_ } else if (field.foreignKey) { _%>
    <%= field.camelName %>: uuid('<%= field.name %>'),
<%_ } else { _%>
    <%= field.camelName %>: <%- field.drizzleChain %>,
<%_ } _%>
<%_ }) _%>
<%_ } _%>

    // Timestamps
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('<%= tableName %>_unique_idx').on(<%- uniqueOnCamel.map(c => `table.${c}`).join(', ') %>),
  ],
);

export type <%= classNames.entity %> = InferSelectModel<typeof <%= tableVarName %>>;
export type <%= classNames.entity %>Insert = typeof <%= tableVarName %>.$inferInsert;
