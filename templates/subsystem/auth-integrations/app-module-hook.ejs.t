---
to: "<%= appModulePath %>"
inject: true
append: true
skip_if: "IntegrationsAuthModule"
---

// TODO: Register IntegrationsAuthModule (vendored from auth-integrations starter)
// Add to AppModule.imports AFTER AuthModule:
//
//   import { IntegrationsAuthModule } from '@shared/integrations/integrations-auth.module';
//   // ...
//   IntegrationsAuthModule,
//
// Requires AuthModule.forRoot(...) registered first (provides ENCRYPTION_KEY).
// Run `cdp entity new integration` to scaffold the codegen layer the adapters import.
