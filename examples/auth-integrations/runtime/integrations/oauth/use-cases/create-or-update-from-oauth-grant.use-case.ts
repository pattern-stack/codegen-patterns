import { Inject, Injectable } from '@nestjs/common';
import {
  ENCRYPTION_KEY,
  type IEncryptionKey,
  type IntegrationGrantInput,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { IntegrationService } from '../../integration.service';
import type { Integration } from '../../integration.entity';

/**
 * Persists an OAuth2 grant from the authorize-code callback (initial
 * connect or re-connect). Upserts on `(user_id, provider)`:
 *
 *   - existing row → re-encrypt + persist tokens, status → 'active'
 *   - missing row  → insert a new row in 'active' status
 *
 * The input shape is exactly `IntegrationGrantInput` from the auth
 * subsystem so `IntegrationGrantSinkAdapter` can be a pass-through —
 * the port and use case share the same boundary type. Encryption is
 * applied here (inside the use case) before ciphertexts hit the row.
 *
 * Re-connect semantics: if the new grant omits `refreshToken`
 * (provider didn't return one), the existing ciphertext is preserved
 * — providers commonly omit the refresh token on a re-grant when
 * they haven't rotated it.
 */
@Injectable()
export class CreateOrUpdateFromOAuthGrantUseCase {
  constructor(
    private readonly integrations: IntegrationService,
    @Inject(ENCRYPTION_KEY) private readonly encryption: IEncryptionKey,
  ) {}

  async execute(input: IntegrationGrantInput): Promise<Integration> {
    const accessTokenEncrypted = await this.encryption.encrypt(input.accessToken);
    const refreshTokenEncrypted =
      input.refreshToken !== undefined
        ? await this.encryption.encrypt(input.refreshToken)
        : undefined;

    const existing = await this.integrations.findByUserIdAndProvider(
      input.userId,
      input.provider,
    );

    const baseRow = {
      userId: input.userId,
      provider: input.provider,
      accessTokenEncrypted,
      expiresAt: input.expiresAt ?? null,
      externalAccountId: input.externalAccountId ?? null,
      scopes: input.scope ?? null,
      providerMetadata: input.providerMetadata ?? null,
      status: 'active' as const,
    };

    if (existing) {
      // Preserve the existing refresh-token ciphertext when the grant
      // didn't include a new refresh token (common on re-grants).
      const patch: Partial<Integration> = {
        ...baseRow,
        refreshTokenEncrypted:
          refreshTokenEncrypted !== undefined
            ? refreshTokenEncrypted
            : existing.refreshTokenEncrypted,
      };
      return this.integrations.update(existing.id, patch);
    }

    return this.integrations.create({
      ...baseRow,
      refreshTokenEncrypted: refreshTokenEncrypted ?? null,
    });
  }
}
