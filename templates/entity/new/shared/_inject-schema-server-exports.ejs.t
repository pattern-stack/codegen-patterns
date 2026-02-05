---
to: "<%= generate.schemaServer ? locations.dbSchemaServer.path : '' %>"
inject: true
after: "// Codegen exports"
skip_if: "export type <%= className %>Record"
---
<% if (generate.schemaServer) { -%>
<% if (hasRelationships) { -%>
<%
const usesOne = belongsToRelations.length > 0 || hasOneRelations.length > 0;
const usesMany = hasManyRelations.length > 0;
const destructured = [usesOne ? 'one' : '', usesMany ? 'many' : ''].filter(Boolean).join(', ');
-%>
export const <%= plural %>Relations = relations(<%= plural %>, ({ <%= destructured %> }) => ({
<% belongsToRelations.forEach((rel) => { -%>
	<%= rel.name %>: one(<%= rel.targetPlural %>, {
		fields: [<%= plural %>.<%= rel.foreignKeyCamel %>],
		references: [<%= rel.targetPlural %>.id],
	}),
<% }) -%>
<% hasManyRelations.forEach((rel) => { -%>
	<%= rel.name %>: many(<%= rel.targetPlural %>),
<% }) -%>
<% hasOneRelations.forEach((rel) => { -%>
	<%= rel.name %>: one(<%= rel.targetPlural %>),
<% }) -%>
}));

<% } -%>
export type <%= className %>Record = typeof <%= plural %>.$inferSelect;
export type New<%= className %>Record = typeof <%= plural %>.$inferInsert;
<% } -%>
