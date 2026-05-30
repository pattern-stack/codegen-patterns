import { Injectable } from '@nestjs/common';
import { ConnectionService } from '../../connection.service';
import type { Connection } from '../../connection.entity';

/**
 * User-initiated disconnect. Flips status to `revoked` and clears the
 * stored ciphertexts so a leaked DB dump never re-grants access. The
 * row is preserved (audit trail, FK integrity); a follow-up grant on
 * the same `(user_id, provider)` will re-activate it via
 * CreateOrUpdateFromOAuthGrantUseCase.
 *
 * Note: this does NOT call the provider's revoke endpoint. Providers
 * vary widely on revoke API shapes — that step belongs in a
 * provider-specific strategy if/when needed (out of scope for the
 * starter).
 */
@Injectable()
export class DisconnectConnectionUseCase {
  constructor(private readonly connections: ConnectionService) {}

  async execute(connectionId: string): Promise<Connection> {
    return this.connections.update(connectionId, {
      status: 'revoked',
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
    });
  }
}
