import { Injectable } from '@nestjs/common';
import { IntegrationService } from '../../../modules/integrations/integration.service';
import type { Integration } from '../../../modules/integrations/integration.entity';

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
export class DisconnectIntegrationUseCase {
  constructor(private readonly integrations: IntegrationService) {}

  async execute(integrationId: string): Promise<Integration> {
    return this.integrations.update(integrationId, {
      status: 'revoked',
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      expiresAt: null,
    });
  }
}
