---
to: "<%= generate.schemaServer && hasEntityRefFields ? locations.dbSchemaServer.path : '' %>"
inject: true
after: "from 'drizzle-orm/pg-core';"
skip_if: "entityTypeEnum"
---
<% if (generate.schemaServer && hasEntityRefFields) { -%>
import { entityTypeEnum } from './entity-types.schema';
<% } -%>
