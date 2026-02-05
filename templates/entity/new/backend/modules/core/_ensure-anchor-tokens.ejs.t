---
to: "<%= exposeRepository ? `${locations.backendConstants.path}/tokens.ts` : '' %>"
inject: true
append: true
skip_if: "// Generated entity repository tokens"
---
<% if (exposeRepository) { -%>

// Generated entity repository tokens
<% } -%>
