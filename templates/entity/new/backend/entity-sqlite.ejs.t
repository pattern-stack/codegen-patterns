---
to: "<%= outputPaths.sqliteEntity %>"
force: true
---
<%- generatedBanner %>
<%_ /* Hygen renders a body even when `to:` is null (Postgres): print only the banner then, which is never written. */ _%>
<%_ if (sqliteTable) { _%>
import {
<%_ sqliteTable.coreImports.forEach(i => { _%>
  <%= i %>,
<%_ }) _%>
<%_ if (sqliteTable.usesAnyColumn) { _%>
  type AnySQLiteColumn,
<%_ } _%>
} from 'drizzle-orm/sqlite-core';
import { <%- sqliteTable.usesSql ? 'sql, ' : '' %>type InferSelectModel } from 'drizzle-orm';
<%_ sqliteTableImports.forEach(imp => { _%>
import { <%= imp.name %> } from '<%= imp.importPath %>';
<%_ }) _%>

export const <%= entityNamePlural %> = sqliteTable(
  '<%= entityTableName %>',
  {
<%_ sqliteTable.columns.forEach(line => { _%>
    <%- line %>,
<%_ }) _%>
  },
<%_ if (sqliteTable.extra.length > 0) { _%>
  (<%= tableCallbackParam %>) => [
<%_ sqliteTable.extra.forEach(c => { _%>
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
<%_ } _%>
