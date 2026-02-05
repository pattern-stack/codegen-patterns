---
to: "<%= generate.schemaClient ? locations.dbSchemaClient.path : '' %>"
inject: true
after: "// Codegen tables"
skip_if: "export const <%= plural %> ="
---
<% if (generate.schemaClient) { -%>
export const <%= plural %> = pgTable('<%= table %>', {
	id: uuid('id').primaryKey(),
<% fields.forEach((field) => { -%>
<% const colName = field.name.replace(/([A-Z])/g, '_$1').toLowerCase(); -%>
<% if (field.drizzleType === 'varchar') { -%>
	<%= field.camelName %>: varchar('<%= colName %>'<%= field.maxLength ? `, { length: ${field.maxLength} }` : '' %>)<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'uuid') { -%>
	<%= field.camelName %>: uuid('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'integer') { -%>
	<%= field.camelName %>: integer('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'decimal') { -%>
	<%= field.camelName %>: numeric('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'boolean') { -%>
	<%= field.camelName %>: boolean('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'date') { -%>
	<%= field.camelName %>: date('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'timestamp') { -%>
	<%= field.camelName %>: timestamp('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'jsonb') { -%>
	<%= field.camelName %>: jsonb('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'text_array') { -%>
	<%= field.camelName %>: text('<%= colName %>').array()<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } -%>
<% }) -%>
<% if (hasTimestamps) { -%>
	createdAt: timestamp('created_at').notNull(),
	updatedAt: timestamp('updated_at').notNull(),
<% } -%>
});

export const <%= plural %>Columns = getTableConfig(<%= plural %>).columns;
<% } -%>
