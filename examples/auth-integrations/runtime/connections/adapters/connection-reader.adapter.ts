import type {
  DecryptedConnection,
  IEncryptionKey,
  IConnectionReader,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import type { ConnectionRows } from '../connection-rows';

/**
 * `IConnectionReader` adapter — fetches the connection row by id and
 * decrypts its ciphertexts to satisfy the auth subsystem's read port.
 *
 * Stays narrow on purpose: this adapter exists purely to feed
 * `OAuth2RefreshStrategy.resolve()`. Anything wider belongs in
 * `ConnectionsService` (the consumer-facing facade).
 *
 * Note: this duplicates the decryption logic in `ConnectionsService`
 * by design — the adapter must not depend on the facade because the
 * facade depends on the use cases which depend on the adapter (well,
 * not directly, but via the same module). Keeping the read path
 * standalone avoids a circular DI graph and matches the auth
 * subsystem's "narrow port" contract.
 */
export class ConnectionReaderAdapter implements IConnectionReader {
  constructor(
    private readonly connections: ConnectionRows,
    private readonly encryption: IEncryptionKey,
  ) {}

  async findByIdDecrypted(connectionId: string): Promise<DecryptedConnection | null> {
    const row = await this.connections.findById(connectionId);
    if (!row) return null;

    const accessToken = row.accessTokenEncrypted
      ? await this.encryption.decrypt(row.accessTokenEncrypted)
      : '';
    const refreshToken = row.refreshTokenEncrypted
      ? await this.encryption.decrypt(row.refreshTokenEncrypted)
      : null;

    return {
      id: row.id,
      provider: row.provider,
      accessToken,
      refreshToken,
      expiresAt: row.expiresAt,
      providerMetadata: (row.providerMetadata as Record<string, unknown> | null) ?? null,
    };
  }
}
