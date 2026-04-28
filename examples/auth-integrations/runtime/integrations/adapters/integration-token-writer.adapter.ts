import { Inject, Injectable } from '@nestjs/common';
import {
  ENCRYPTION_KEY,
  type IEncryptionKey,
  type IIntegrationTokenWriter,
  type IntegrationTokenUpdate,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { IntegrationService } from '../integration.service';

/**
 * `IIntegrationTokenWriter` adapter — encrypts the new access token
 * (and rotated refresh token, if present) and persists them onto the
 * integration row.
 *
 * `IntegrationTokenUpdate.refreshToken` semantics:
 *   - `undefined` → provider didn't rotate, leave existing ciphertext
 *   - `string`    → provider rotated, re-encrypt + persist
 *
 * On a successful refresh we also flip status back to 'active' — if
 * the row was previously `requires_reauth` and the user re-connected,
 * a successful refresh is the signal that the integration is healthy
 * again.
 */
@Injectable()
export class IntegrationTokenWriterAdapter implements IIntegrationTokenWriter {
  constructor(
    private readonly integrations: IntegrationService,
    @Inject(ENCRYPTION_KEY) private readonly encryption: IEncryptionKey,
  ) {}

  async persistRefresh(update: IntegrationTokenUpdate): Promise<void> {
    const accessTokenEncrypted = await this.encryption.encrypt(update.accessToken);
    const patch: Record<string, unknown> = {
      accessTokenEncrypted,
      expiresAt: update.expiresAt,
      status: 'active',
    };
    if (update.refreshToken !== undefined) {
      patch.refreshTokenEncrypted = await this.encryption.encrypt(update.refreshToken);
    }
    await this.integrations.update(update.integrationId, patch);
  }
}
