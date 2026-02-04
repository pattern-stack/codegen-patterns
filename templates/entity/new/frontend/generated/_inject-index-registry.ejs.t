---
to: <%= locations.frontendGenerated.path %>/index.ts
inject: true
skip_if: "<%= camelName %>,"
after: "// registry-entries"
---
	<%= camelName %>,
