---
to: "<%= envConfigPath %>"
inject: true
append: true
skip_if: "TOKEN_ENCRYPTION_KEY"
---

# OAuth integration token encryption key — 32 bytes b64 — DO NOT REUSE in prod
TOKEN_ENCRYPTION_KEY=<%= tokenEncryptionKey %>
# Public base URL where OAuth providers redirect back. Override in staging/prod.
AUTH_REDIRECT_URI_BASE=<%= redirectUriBase %>
