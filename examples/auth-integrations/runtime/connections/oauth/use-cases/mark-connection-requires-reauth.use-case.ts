import { Injectable } from '@nestjs/common';
import { ConnectionService } from '../../connection.service';
import type { Connection } from '../../connection.entity';

/**
 * Flips an connection's status to `requires_reauth`. Called when the
 * refresh path raises `ConnectionBrokenError` (refresh token rejected,
 * scopes revoked, etc.) — see `OAuth2RefreshStrategy` + `withAuthRetry`.
 *
 * Idempotent: calling on an already-broken row is a no-op write.
 */
@Injectable()
export class MarkConnectionRequiresReauthUseCase {
  constructor(private readonly connections: ConnectionService) {}

  async execute(connectionId: string): Promise<Connection> {
    return this.connections.update(connectionId, {
      status: 'requires_reauth',
    });
  }
}
