---
to: "<%= generate.schemaClient ? locations.dbSchemaClient.path : '' %>"
inject: true
after: "// Codegen tables"
skip_if: "export const <%= plural %> ="
---
<% if (generate.schemaClient) { -%>
<% if (enumFields.length > 0) { -%>
// Enum definitions
<% enumFields.forEach((field) => { -%>
export const <%= field.enumName %> = pgEnum('<%= field.name %>', [<%- field.choices.map(c => `'${c}'`).join(', ') %>]);
<% }) -%>

<% } -%>
export const <%= plural %> = pgTable('<%= table %>', {
	id: uuid('id').defaultRandom().primaryKey(),
<% fields.forEach((field) => { -%>
<% const colName = field.name.replace(/([A-Z])/g, '_$1').toLowerCase(); -%>
<% const belongsToRel = belongsToRelations.find(r => r.foreignKeyCamel === field.camelName); -%>
<% if (field.drizzleType === 'entity_type_enum') { -%>
	<%= field.camelName %>: entityTypeEnum('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'text_array') { -%>
	<%= field.camelName %>: text('<%= colName %>').array()<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'enum') { -%>
	<%= field.camelName %>: <%= field.enumName %>('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'varchar') { -%>
	<%= field.camelName %>: varchar('<%= colName %>'<%= field.maxLength ? `, { length: ${field.maxLength} }` : '' %>)<%= field.required && !field.nullable ? '.notNull()' : '' %><%= field.unique ? '.unique()' : '' %>,
<% } else if (field.drizzleType === 'uuid') { -%>
<% if (belongsToRel) { -%>
	<%= field.camelName %>: uuid('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>.references(() => <%= belongsToRel.targetPlural %>.id),
<% } else { -%>
	<%= field.camelName %>: uuid('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %><%= field.unique ? '.unique()' : '' %>,
<% } -%>
<% } else if (field.drizzleType === 'integer') { -%>
	<%= field.camelName %>: integer('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'decimal') { -%>
	<%= field.camelName %>: doublePrecision('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'boolean') { -%>
	<%= field.camelName %>: boolean('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %><%= field.default !== undefined ? `.default(${field.default})` : '' %>,
<% } else if (field.drizzleType === 'date') { -%>
	<%= field.camelName %>: date('<%= colName %>', { mode: 'date' })<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'timestamp') { -%>
	<%= field.camelName %>: timestamp('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } else if (field.drizzleType === 'jsonb') { -%>
	<%= field.camelName %>: jsonb('<%= colName %>')<%= field.required && !field.nullable ? '.notNull()' : '' %>,
<% } -%>
<% }) -%>
<% if (hasTimestamps) { -%>
	// timestamps behavior
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull(),
<% } -%>
<% if (hasSoftDelete) { -%>
	// soft_delete behavior
	deletedAt: timestamp('deleted_at'),
<% } -%>
<% if (hasUserTracking) { -%>
	// user_tracking behavior
	createdBy: uuid('created_by'),
	updatedBy: uuid('updated_by'),
<% } -%>
<% if (hasTemporalValidity) { -%>
	// temporal_validity behavior
	validFrom: timestamp('valid_from'),
	validTo: timestamp('valid_to'),
	isActive: boolean('is_active').default(true).notNull(),
<% } -%>
}<%
const fkIndexes = belongsToRelations.map(rel => ({
  name: rel.foreignKeyCamel,
  colName: rel.foreignKey.replace(/([A-Z])/g, '_$1').toLowerCase()
}));
const fieldIndexes = fields.filter(f => f.index).map(f => ({
  name: f.camelName,
  colName: f.name.replace(/([A-Z])/g, '_$1').toLowerCase()
}));
const allIndexes = [...fkIndexes, ...fieldIndexes];
const hasTableConfig = hasEntityRefFields || allIndexes.length > 0;
-%>
<% if (hasTableConfig) { -%>, (table) => ({
<% entityRefFields.forEach((ref) => { -%>
	<%= ref.camelName %>Idx: index('idx_<%= table %>_<%= ref.name %>').on(table.<%= ref.camelName %>EntityType, table.<%= ref.camelName %>EntityId),
<% }) -%>
<% allIndexes.forEach((idx) => { -%>
	<%= idx.name %>Idx: index('idx_<%= table %>_<%= idx.colName %>').on(table.<%= idx.name %>),
<% }) -%>
})<% } -%>);
<% } -%>
