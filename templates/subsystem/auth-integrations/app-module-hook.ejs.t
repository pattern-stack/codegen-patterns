---
to: "<%= appModulePath %>"
inject: true
append: true
skip_if: "ConnectionsAuthModule"
---

// TODO: Register ConnectionsAuthModule (vendored from auth-integrations starter)
// Add to AppModule.imports AFTER AuthModule:
//
//   import { ConnectionsAuthModule } from '@shared/connections/connections-auth.module';
//   // ...
//   ConnectionsAuthModule,
//
// Requires AuthModule.forRoot(...) registered first (provides ENCRYPTION_KEY).
// Run `cdp entity new connection` to scaffold the codegen layer the adapters import.
