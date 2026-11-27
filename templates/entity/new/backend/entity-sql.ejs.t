---
to: "<%= outputPaths.sqliteDdl %>"
force: true
---
<%- generatedBanner.replace(/^\/\//, '--') %>
<%_ /* Hygen renders a body even when `to:` is null (Postgres): print only the banner then, which is never written. */ _%>
<%_ if (sqliteDdl) { _%>
-- TGT-2b: this table's SQLite DDL, from the same facts as its sqliteTable module. IF NOT EXISTS throughout, so it
-- can be applied again.
<%- sqliteDdl %>
<%_ } _%>
