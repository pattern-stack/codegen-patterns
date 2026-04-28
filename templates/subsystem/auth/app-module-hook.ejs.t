---
to: "<%= appModulePath %>"
inject: true
append: true
skip_if: "AuthModule"
---

// TODO: Register AuthModule (auth subsystem)
// Add to AppModule.imports:
//
//   import { AuthModule } from '@shared/subsystems/auth';
//   // ...
//   AuthModule.forRoot({
//     encryptionKey: 'env',
//     oauthStateStore: 'drizzle',
//     enableController: true,
//     redirectUriBase: process.env.AUTH_REDIRECT_URI_BASE ?? '<%= redirectUriBase %>',
//   }),
//
// Requires TOKEN_ENCRYPTION_KEY in your environment (see .env.config).
// Provide an IUserContext adapter (your app's session/JWT scheme).
