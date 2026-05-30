import { Injectable } from '@nestjs/common';
import { ConnectionService } from '../../connection.service';
import type { Connection } from '../../connection.entity';

/**
 * Lists a user's connections newest-first. Used by the settings page
 * (`GET /connections`) and any "which providers are connected?" UI.
 *
 * Returns rows with ciphertexts intact — callers should NOT pass these
 * to the frontend. Use `ConnectionsService.listByUser` if you need
 * the consumer-facing facade behavior (which strips ciphertexts before
 * returning).
 */
@Injectable()
export class ListUserConnectionsUseCase {
  constructor(private readonly connections: ConnectionService) {}

  async execute(userId: string): Promise<Connection[]> {
    return this.connections.findByUserId(userId);
  }
}
