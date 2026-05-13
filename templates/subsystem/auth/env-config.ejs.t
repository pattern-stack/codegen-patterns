---
to: "<%= envConfigPath %>"
inject: true
append: true
skip_if: "INTEGRATION_TOKEN_ENCRYPTION_KEY"
---

# OAuth integration token encryption key — 32 bytes base64 (AES-256-GCM).
# DO NOT REUSE this dev value in prod. To regenerate locally:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Re-running `codegen subsystem install auth` does NOT rotate this key —
# `skip_if: "INTEGRATION_TOKEN_ENCRYPTION_KEY"` blocks the inject intentionally,
# because silently rotating would invalidate every encrypted token already in
# the consumer's `integrations` table. Rotation is a separate, auditable op.
# In production: store the key in `secrets/secrets.yaml` (or your secret
# manager) and have your deploy pipeline materialise it into the env at
# boot — this `.env.config` line should be a placeholder, not the source.
INTEGRATION_TOKEN_ENCRYPTION_KEY=<%= tokenEncryptionKey %>
# Public base URL where OAuth providers redirect back. Override in staging/prod.
AUTH_REDIRECT_URI_BASE=<%= redirectUriBase %>
