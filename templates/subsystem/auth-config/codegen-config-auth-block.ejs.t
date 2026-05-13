---
to: "<%= configPath %>"
inject: true
append: true
skip_if: "auth:"
---

auth:
  # ── Encryption key (INTEGRATION_TOKEN_ENCRYPTION_KEY from .env.config) ──
  encryption_key: env

  # ── OAuth state store (drizzle for prod, memory for tests) ──
  oauth_state_store: drizzle

  # ── Public base URL — providers redirect back here ──
  # Override in staging/prod via AUTH_REDIRECT_URI_BASE env var.
  redirect_uri_base: http://localhost:3000

  # ── Mount AuthController under /auth/:provider ──
  enable_controller: true
