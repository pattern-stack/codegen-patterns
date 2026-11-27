import { Global, Module } from '@nestjs/common';
import {
  AUTH_CONNECTION_GRANT_SINK,
  AUTH_CONNECTION_READER,
  AUTH_CONNECTION_TOKEN_WRITER,
  ENCRYPTION_KEY,
  type IEncryptionKey,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { ConnectionsModule } from './connections.module';
import { ConnectionService } from './connection.service';
import { createConnectionStore, type ConnectionStore } from './connection-store';
import { ConnectionsService } from './facade/connections.service';

/** The one store this module builds; every binding below is a part of it. */
const CONNECTION_STORE = Symbol.for('auth-integrations:connection-store');

/**
 * `ConnectionsAuthModule` — wires the consumer-side adapters that
 * satisfy the auth subsystem's three connection-store ports plus the
 * `ConnectionsService` facade and its use cases.
 *
 * The classes are plain (S-2): `createConnectionStore` builds them all over
 * the codegen-emitted `ConnectionService` and the `ENCRYPTION_KEY` — the same
 * construction the pattern-stack `connections` system runs over the
 * connection repository. This module provides that store once and binds its
 * parts.
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
 *   - AUTH_CONNECTION_READER       → the store's `reader`
 *   - AUTH_CONNECTION_TOKEN_WRITER → the store's `tokenWriter`
 *   - AUTH_CONNECTION_GRANT_SINK   → the store's `grantSink`
 *   - ConnectionsService           → the store's `connections` (the facade)
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
    {
      provide: CONNECTION_STORE,
      useFactory: (connections: ConnectionService, encryption: IEncryptionKey): ConnectionStore =>
        createConnectionStore(connections, encryption),
      inject: [ConnectionService, ENCRYPTION_KEY],
    },
    // Facade (consumer-facing API; controllers/handlers inject this class).
    {
      provide: ConnectionsService,
      useFactory: (store: ConnectionStore) => store.connections,
      inject: [CONNECTION_STORE],
    },
    // Subsystem port adapters, under the auth subsystem's tokens.
    {
      provide: AUTH_CONNECTION_READER,
      useFactory: (store: ConnectionStore) => store.reader,
      inject: [CONNECTION_STORE],
    },
    {
      provide: AUTH_CONNECTION_TOKEN_WRITER,
      useFactory: (store: ConnectionStore) => store.tokenWriter,
      inject: [CONNECTION_STORE],
    },
    {
      provide: AUTH_CONNECTION_GRANT_SINK,
      useFactory: (store: ConnectionStore) => store.grantSink,
      inject: [CONNECTION_STORE],
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
