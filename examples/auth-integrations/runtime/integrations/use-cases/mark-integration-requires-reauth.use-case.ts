import { Injectable } from '@nestjs/common';
import { IntegrationService } from '../../../modules/integrations/integration.service';
import type { Integration } from '../../../modules/integrations/integration.entity';

/**
 * Flips an integration's status to `requires_reauth`. Called when the
 * refresh path raises `IntegrationBrokenError` (refresh token rejected,
 * scopes revoked, etc.) — see `OAuth2RefreshStrategy` + `withAuthRetry`.
 *
 * Idempotent: calling on an already-broken row is a no-op write.
 */
@Injectable()
export class MarkIntegrationRequiresReauthUseCase {
  constructor(private readonly integrations: IntegrationService) {}

  async execute(integrationId: string): Promise<Integration> {
    return this.integrations.update(integrationId, {
      status: 'requires_reauth',
    });
  }
}
