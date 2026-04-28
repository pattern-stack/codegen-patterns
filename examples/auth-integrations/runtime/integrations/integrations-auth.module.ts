import { Global, Module } from '@nestjs/common';
import {
  AUTH_INTEGRATION_GRANT_SINK,
  AUTH_INTEGRATION_READER,
  AUTH_INTEGRATION_TOKEN_WRITER,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { IntegrationsModule } from './integrations.module';
import { IntegrationGrantSinkAdapter } from './adapters/integration-grant-sink.adapter';
import { IntegrationReaderAdapter } from './adapters/integration-reader.adapter';
import { IntegrationTokenWriterAdapter } from './adapters/integration-token-writer.adapter';
import { IntegrationsService } from './facade/integrations.service';
import { CreateOrUpdateFromOAuthGrantUseCase } from './oauth/use-cases/create-or-update-from-oauth-grant.use-case';
import { DisconnectIntegrationUseCase } from './oauth/use-cases/disconnect-integration.use-case';
import { ListUserIntegrationsUseCase } from './oauth/use-cases/list-user-integrations.use-case';
import { MarkIntegrationRequiresReauthUseCase } from './oauth/use-cases/mark-integration-requires-reauth.use-case';

/**
 * `IntegrationsAuthModule` — wires the consumer-side adapters that
 * satisfy the auth subsystem's three integration-store ports plus the
 * `IntegrationsService` facade and its use cases.
 *
 * Imports `IntegrationsModule` (the codegen-emitted entity module) to
 * pull in `IntegrationService` + its repository.
 *
 * Depends on a registered `ENCRYPTION_KEY` provider — that comes from
 * `AuthModule.forRoot({ encryptionKey: ... })`. Make sure
 * `AuthModule.forRoot(...)` is imported in your app's root module BEFORE
 * `IntegrationsAuthModule` (or globally — `AuthModule` is `global: true`
 * by convention).
 *
 * Token bindings (per #285 / #286):
 *   - AUTH_INTEGRATION_READER       → IntegrationReaderAdapter
 *   - AUTH_INTEGRATION_TOKEN_WRITER → IntegrationTokenWriterAdapter
 *   - AUTH_INTEGRATION_GRANT_SINK   → IntegrationGrantSinkAdapter
 *
 * `@Global()` is required: `AuthController` lives inside `AuthModule`'s
 * own injector and resolves the `AUTH_INTEGRATION_*` providers exposed
 * here. Without `@Global()`, the controller's injector cannot see these
 * tokens and Nest fails to boot. Same pattern as the `auth-bindings`
 * module shipped in #93.
 */
@Global()
@Module({
  imports: [IntegrationsModule],
  providers: [
    // Use cases (consumed by the facade)
    CreateOrUpdateFromOAuthGrantUseCase,
    MarkIntegrationRequiresReauthUseCase,
    DisconnectIntegrationUseCase,
    ListUserIntegrationsUseCase,

    // Facade (consumer-facing API; controllers/handlers inject this)
    IntegrationsService,

    // Subsystem port adapters (concrete classes — also exposed under
    // their token aliases for `@Inject(...)` consumers in the auth
    // subsystem).
    IntegrationReaderAdapter,
    IntegrationTokenWriterAdapter,
    IntegrationGrantSinkAdapter,
    {
      provide: AUTH_INTEGRATION_READER,
      useExisting: IntegrationReaderAdapter,
    },
    {
      provide: AUTH_INTEGRATION_TOKEN_WRITER,
      useExisting: IntegrationTokenWriterAdapter,
    },
    {
      provide: AUTH_INTEGRATION_GRANT_SINK,
      useExisting: IntegrationGrantSinkAdapter,
    },
  ],
  exports: [
    IntegrationsService,
    AUTH_INTEGRATION_READER,
    AUTH_INTEGRATION_TOKEN_WRITER,
    AUTH_INTEGRATION_GRANT_SINK,
  ],
})
export class IntegrationsAuthModule {}
