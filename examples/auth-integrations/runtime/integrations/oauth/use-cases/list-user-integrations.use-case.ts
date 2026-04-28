import { Injectable } from '@nestjs/common';
import { IntegrationService } from '../../integration.service';
import type { Integration } from '../../integration.entity';

/**
 * Lists a user's integrations newest-first. Used by the settings page
 * (`GET /integrations`) and any "which providers are connected?" UI.
 *
 * Returns rows with ciphertexts intact — callers should NOT pass these
 * to the frontend. Use `IntegrationsService.listByUser` if you need
 * the consumer-facing facade behavior (which strips ciphertexts before
 * returning).
 */
@Injectable()
export class ListUserIntegrationsUseCase {
  constructor(private readonly integrations: IntegrationService) {}

  async execute(userId: string): Promise<Integration[]> {
    return this.integrations.findByUserId(userId);
  }
}
