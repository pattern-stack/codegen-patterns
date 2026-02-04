---
to: apps/frontend/src/generated/index.ts
inject: true
skip_if: "<%= camelName %>,"
after: "// registry-entries"
---
	<%= camelName %>,
