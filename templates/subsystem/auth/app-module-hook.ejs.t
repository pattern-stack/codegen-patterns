---
to: "<%= appModulePath %>"
inject: true
append: true
skip_if: "AuthModule"
---

// TODO: Wire AuthModule (auth subsystem) — closed-by-default data plane (ADR-043).
//
// The auth runtime is now vendored. To wire the global AuthenticatedGuard +
// the RequesterContext boundary + the boot-fail check into app.module.ts and
// main.ts automatically, run:
//
//   codegen project upgrade-auth
//
// That inserts `AuthModule.forRoot({...})` here and `installRequesterContext(app)`
// + the boot-fail block in main.ts (idempotent AST patch). You still must:
//   1. Set INTEGRATION_TOKEN_ENCRYPTION_KEY in your environment (see .env.config).
//   2. Bind an IUserContext (your app's session/JWT scheme) under
//      AUTH_USER_CONTEXT — until you do, the data plane refuses to serve.
//
// To enable the OAuth connect/callback controller, pass
// `enableController: true, redirectUriBase: process.env.AUTH_REDIRECT_URI_BASE ?? '<%= redirectUriBase %>'`
// to AuthModule.forRoot (edit the entry after running upgrade-auth).
