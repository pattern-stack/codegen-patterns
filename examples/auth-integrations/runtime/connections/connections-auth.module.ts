import { Global, Module } from '@nestjs/common';
import {
  AUTH_CONNECTION_GRANT_SINK,
  AUTH_CONNECTION_READER,
  AUTH_CONNECTION_TOKEN_WRITER,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { ConnectionsModule } from './connections.module';
import { ConnectionGrantSinkAdapter } from './adapters/connection-grant-sink.adapter';
import { ConnectionReaderAdapter } from './adapters/connection-reader.adapter';
import { ConnectionTokenWriterAdapter } from './adapters/connection-token-writer.adapter';
import { ConnectionsService } from './facade/connections.service';
import { CreateOrUpdateFromOAuthGrantUseCase } from './oauth/use-cases/create-or-update-from-oauth-grant.use-case';
import { DisconnectConnectionUseCase } from './oauth/use-cases/disconnect-connection.use-case';
import { ListUserConnectionsUseCase } from './oauth/use-cases/list-user-connections.use-case';
import { MarkConnectionRequiresReauthUseCase } from './oauth/use-cases/mark-connection-requires-reauth.use-case';

/**
 * `ConnectionsAuthModule` — wires the consumer-side adapters that
 * satisfy the auth subsystem's three connection-store ports plus the
 * `ConnectionsService` facade and its use cases.
 *
 * Imports `ConnectionsModule` (the codegen-emitted entity module) to
 * pull in `ConnectionService` + its repository.
 *
 * Depends on a registered `ENCRYPTION_KEY` provider — that comes from
 * `AuthModule.forRoot({ encryptionKey: ... })`. Make sure
 * `AuthModule.forRoot(...)` is imported in your app's root module BEFORE
 * `ConnectionsAuthModule` (or globally — `AuthModule` is `global: true`
 * by convention).
 *
 * Token bindings (per #285 / #286):
 *   - AUTH_CONNECTION_READER       → ConnectionReaderAdapter
 *   - AUTH_CONNECTION_TOKEN_WRITER → ConnectionTokenWriterAdapter
 *   - AUTH_CONNECTION_GRANT_SINK   → ConnectionGrantSinkAdapter
 *
 * `@Global()` is required: `AuthController` lives inside `AuthModule`'s
 * own injector and resolves the `AUTH_CONNECTION_*` providers exposed
 * here. Without `@Global()`, the controller's injector cannot see these
 * tokens and Nest fails to boot. Same pattern as the `auth-bindings`
 * module shipped in #93.
 */
@Global()
@Module({
  imports: [ConnectionsModule],
  providers: [
    // Use cases (consumed by the facade)
    CreateOrUpdateFromOAuthGrantUseCase,
    MarkConnectionRequiresReauthUseCase,
    DisconnectConnectionUseCase,
    ListUserConnectionsUseCase,

    // Facade (consumer-facing API; controllers/handlers inject this)
    ConnectionsService,

    // Subsystem port adapters (concrete classes — also exposed under
    // their token aliases for `@Inject(...)` consumers in the auth
    // subsystem).
    ConnectionReaderAdapter,
    ConnectionTokenWriterAdapter,
    ConnectionGrantSinkAdapter,
    {
      provide: AUTH_CONNECTION_READER,
      useExisting: ConnectionReaderAdapter,
    },
    {
      provide: AUTH_CONNECTION_TOKEN_WRITER,
      useExisting: ConnectionTokenWriterAdapter,
    },
    {
      provide: AUTH_CONNECTION_GRANT_SINK,
      useExisting: ConnectionGrantSinkAdapter,
    },
  ],
  exports: [
    ConnectionsService,
    AUTH_CONNECTION_READER,
    AUTH_CONNECTION_TOKEN_WRITER,
    AUTH_CONNECTION_GRANT_SINK,
  ],
})
export class ConnectionsAuthModule {}
