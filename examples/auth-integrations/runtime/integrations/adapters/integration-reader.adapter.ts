import { Inject, Injectable } from '@nestjs/common';
import {
  ENCRYPTION_KEY,
  type DecryptedIntegration,
  type IEncryptionKey,
  type IIntegrationReader,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { IntegrationService } from '../integration.service';

/**
 * `IIntegrationReader` adapter — fetches the integration row by id and
 * decrypts its ciphertexts to satisfy the auth subsystem's read port.
 *
 * Stays narrow on purpose: this adapter exists purely to feed
 * `OAuth2RefreshStrategy.resolve()`. Anything wider belongs in
 * `IntegrationsService` (the consumer-facing facade).
 *
 * Note: this duplicates the decryption logic in `IntegrationsService`
 * by design — the adapter must not depend on the facade because the
 * facade depends on the use cases which depend on the adapter (well,
 * not directly, but via the same module). Keeping the read path
 * standalone avoids a circular DI graph and matches the auth
 * subsystem's "narrow port" contract.
 */
@Injectable()
export class IntegrationReaderAdapter implements IIntegrationReader {
  constructor(
    private readonly integrations: IntegrationService,
    @Inject(ENCRYPTION_KEY) private readonly encryption: IEncryptionKey,
  ) {}

  async findByIdDecrypted(integrationId: string): Promise<DecryptedIntegration | null> {
    const row = await this.integrations.findById(integrationId);
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
