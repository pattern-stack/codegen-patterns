---
to: "<%= configPath %>"
inject: true
append: true
skip_if: "auth:"
---

auth:
  # ── Public base URL — providers redirect back here ──
  # Read at `subsystem install auth`: written into .env.config as
  # AUTH_REDIRECT_URI_BASE and into the AuthModule.forRoot TODO. Override in
  # staging/prod via the AUTH_REDIRECT_URI_BASE env var.
  redirect_uri_base: http://localhost:3000
