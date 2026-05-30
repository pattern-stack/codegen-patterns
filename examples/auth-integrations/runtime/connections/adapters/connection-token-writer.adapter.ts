import { Inject, Injectable } from '@nestjs/common';
import {
  ENCRYPTION_KEY,
  type IEncryptionKey,
  type IConnectionTokenWriter,
  type ConnectionTokenUpdate,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { ConnectionService } from '../connection.service';

/**
 * `IConnectionTokenWriter` adapter — encrypts the new access token
 * (and rotated refresh token, if present) and persists them onto the
 * connection row.
 *
 * `ConnectionTokenUpdate.refreshToken` semantics:
 *   - `undefined` → provider didn't rotate, leave existing ciphertext
 *   - `string`    → provider rotated, re-encrypt + persist
 *
 * On a successful refresh we also flip status back to 'active' — if
 * the row was previously `requires_reauth` and the user re-connected,
 * a successful refresh is the signal that the connection is healthy
 * again.
 */
@Injectable()
export class ConnectionTokenWriterAdapter implements IConnectionTokenWriter {
  constructor(
    private readonly connections: ConnectionService,
    @Inject(ENCRYPTION_KEY) private readonly encryption: IEncryptionKey,
  ) {}

  async persistRefresh(update: ConnectionTokenUpdate): Promise<void> {
    const accessTokenEncrypted = await this.encryption.encrypt(update.accessToken);
    const patch: Record<string, unknown> = {
      accessTokenEncrypted,
      expiresAt: update.expiresAt,
      status: 'active',
    };
    if (update.refreshToken !== undefined) {
      patch.refreshTokenEncrypted = await this.encryption.encrypt(update.refreshToken);
    }
    await this.connections.update(update.connectionId, patch);
  }
}
