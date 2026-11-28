import type {
  IConnectionGrantSink,
  IConnectionReader,
  IConnectionTokenWriter,
  IEncryptionKey,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import type { ConnectionRows } from './connection-rows';
import { ConnectionGrantSinkAdapter } from './adapters/connection-grant-sink.adapter';
import { ConnectionReaderAdapter } from './adapters/connection-reader.adapter';
import { ConnectionTokenWriterAdapter } from './adapters/connection-token-writer.adapter';
import { ConnectionsService } from './facade/connections.service';
import { CreateOrUpdateFromOAuthGrantUseCase } from './oauth/use-cases/create-or-update-from-oauth-grant.use-case';
import { DisconnectConnectionUseCase } from './oauth/use-cases/disconnect-connection.use-case';
import { ListUserConnectionsUseCase } from './oauth/use-cases/list-user-connections.use-case';
import { MarkConnectionRequiresReauthUseCase } from './oauth/use-cases/mark-connection-requires-reauth.use-case';

/**
 * The connection store: the auth subsystem's three connection ports and the facade app code calls, over one set of
 * connection rows and the encryption key.
 *
 * - `reader` / `tokenWriter` — what an `OAuth2RefreshStrategy` takes (`connectionReader`, `tokenWriter`).
 * - `grantSink` — what the OAuth callback hands a fresh grant to.
 * - `connections` — the facade: find decrypted, list (ciphertexts stripped), mark requires-reauth, disconnect.
 */
export interface ConnectionStore {
  reader: IConnectionReader;
  tokenWriter: IConnectionTokenWriter;
  grantSink: IConnectionGrantSink;
  connections: ConnectionsService;
}

/**
 * Builds the store. One construction for both hosts (S-2): `ConnectionsAuthModule` calls it with the generated
 * `ConnectionService` and `ENCRYPTION_KEY`, and the pattern-stack `connections` system with the connection repository
 * and the `auth` system's key.
 */
export function createConnectionStore(rows: ConnectionRows, encryption: IEncryptionKey): ConnectionStore {
  const createOrUpdate = new CreateOrUpdateFromOAuthGrantUseCase(rows, encryption);
  return {
    reader: new ConnectionReaderAdapter(rows, encryption),
    tokenWriter: new ConnectionTokenWriterAdapter(rows, encryption),
    grantSink: new ConnectionGrantSinkAdapter(createOrUpdate),
    connections: new ConnectionsService(
      rows,
      encryption,
      createOrUpdate,
      new MarkConnectionRequiresReauthUseCase(rows),
      new DisconnectConnectionUseCase(rows),
      new ListUserConnectionsUseCase(rows),
    ),
  };
}
