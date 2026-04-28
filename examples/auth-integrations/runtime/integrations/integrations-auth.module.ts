import { Module } from '@nestjs/common';
import {
  AUTH_INTEGRATION_GRANT_SINK,
  AUTH_INTEGRATION_READER,
  AUTH_INTEGRATION_TOKEN_WRITER,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { IntegrationsModule } from '../../modules/integrations/integrations.module';
import { IntegrationGrantSinkAdapter } from './integration-grant-sink.adapter';
import { IntegrationReaderAdapter } from './integration-reader.adapter';
import { IntegrationTokenWriterAdapter } from './integration-token-writer.adapter';
import { IntegrationsService } from './integrations.service';
import { CreateOrUpdateFromOAuthGrantUseCase } from './use-cases/create-or-update-from-oauth-grant.use-case';
import { DisconnectIntegrationUseCase } from './use-cases/disconnect-integration.use-case';
import { ListUserIntegrationsUseCase } from './use-cases/list-user-integrations.use-case';
import { MarkIntegrationRequiresReauthUseCase } from './use-cases/mark-integration-requires-reauth.use-case';

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
 */
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
