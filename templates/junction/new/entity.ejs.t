---
to: "<%= outputPaths.entity %>"
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import {
<%_ drizzleImports.forEach(i => { _%>
  <%= i %>,
<%_ }) _%>
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { type InferSelectModel } from 'drizzle-orm';
import { <%= leftTable %> } from '<%= leftEntityImportFromJunction %>';
<%_ if (leftEntity !== rightEntity) { _%>
import { <%= rightTable %> } from '<%= rightEntityImportFromJunction %>';
<%_ } _%>
<%_ payloadFkImports.forEach(imp => { _%>
import { <%= imp.relatedTable %> } from '<%= imp.importPath %>';
<%_ }) _%>

// ============================================================================
// Enums
// ============================================================================
<%_ if (hasRole) { _%>

export const <%= roleEnumName %> = pgEnum('<%= name %>_role', [
<%_ roleEnumValues.forEach(v => { _%>
  '<%= v %>',
<%_ }) _%>
]);
<%_ } _%>
<%_ processedCustomFields.filter(f => f.hasChoices).forEach(field => { _%>

export const <%= field.enumName %> = pgEnum('<%= field.enumDbName %>', [
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
    // FK columns — composite primary key (no surrogate id: Q4 resolution)
    <%= leftColumnCamel %>: uuid('<%= leftColumn %>').notNull().references((): AnyPgColumn => <%= leftTable %>.id, { onDelete: '<%= onDeleteLeft %>' }),
    <%= rightColumnCamel %>: uuid('<%= rightColumn %>').notNull().references((): AnyPgColumn => <%= rightTable %>.id, { onDelete: '<%= onDeleteRight %>' }),
<%_ if (hasRole) { _%>

    // Role enum (per-pairing; declared in junction YAML's fields.role.choices).
    // NOT NULL because role is part of the junction's identity (composite PK
    // below): the same pair with two different roles is two distinct rows.
    role: <%= roleEnumName %>('role').notNull(),
<%_ } _%>
<%_ if (isPrimary) { _%>

    // BaseJunctionFields — is_primary (`is_primary: false` opts out)
    isPrimary: boolean('is_primary').notNull().default(false),
<%_ } _%>
<%_ if (temporal) { _%>

    // Temporal window (temporal: true, default)
    startedAt: <%- timestampColumn('started_at', generatedTimeWithTimezone) %>,
    endedAt: <%- timestampColumn('ended_at', generatedTimeWithTimezone) %>,
<%_ } _%>
<%_ if (sourced) { _%>

    // Provenance (sourced: true, default)
    sourcedFrom: text('sourced_from'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    matchedAt: <%- timestampColumn('matched_at', generatedTimeWithTimezone) %>,
<%_ } _%>
<%_ if (hasCustomFields) { _%>

    // Custom fields
<%_ processedCustomFields.forEach(field => { _%>
    <%= field.camelName %>: <%- field.drizzleChain %>,
<%_ }) _%>
<%_ } _%>
<%_ if (timestamps) { _%>

    // Timestamps
    createdAt: <%- timestampColumn('created_at', generatedTimeWithTimezone) %>.notNull().defaultNow(),
    updatedAt: <%- timestampColumn('updated_at', generatedTimeWithTimezone) %>.notNull().defaultNow(),
<%_ } _%>
  },
  (table) => [
<%_ if (hasRole) { _%>
    // Composite primary key on the two FK columns PLUS role (Q4 resolution: no
    // surrogate id). Role is part of the junction's identity — the same pair
    // with two different roles is two distinct rows (e.g. a contact who is both
    // `champion` and `decision_maker` on one opportunity). This is the
    // ON CONFLICT target for integrationUpsert on role-bearing junctions.
    primaryKey({ columns: [table.<%= leftColumnCamel %>, table.<%= rightColumnCamel %>, table.role] }),
<%_ } else { _%>
    // Composite primary key on the two FK columns (Q4 resolution: no surrogate id)
    primaryKey({ columns: [table.<%= leftColumnCamel %>, table.<%= rightColumnCamel %>] }),
<%_ } _%>
<%_ payloadIndexes.forEach(ix => { _%>
    <%- ix.expr.replace(/\bt\./g, 'table.') %>,
<%_ }) _%>
  ],
);

export type <%= classNames.entity %> = InferSelectModel<typeof <%= tableVarName %>>;
export type <%= classNames.entity %>Insert = typeof <%= tableVarName %>.$inferInsert;
