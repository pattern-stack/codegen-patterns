import { Inject, Injectable } from '@nestjs/common';
import {
  ENCRYPTION_KEY,
  type IEncryptionKey,
  type ConnectionGrantInput,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { ConnectionService } from '../../connection.service';
import type { Connection } from '../../connection.entity';

/**
 * Persists an OAuth2 grant from the authorize-code callback (initial
 * connect or re-connect). Upserts on `(user_id, provider)`:
 *
 *   - existing row → re-encrypt + persist tokens, status → 'active'
 *   - missing row  → insert a new row in 'active' status
 *
 * The input shape is exactly `ConnectionGrantInput` from the auth
 * subsystem so `ConnectionGrantSinkAdapter` can be a pass-through —
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
    private readonly connections: ConnectionService,
    @Inject(ENCRYPTION_KEY) private readonly encryption: IEncryptionKey,
  ) {}

  async execute(input: ConnectionGrantInput): Promise<Connection> {
    const accessTokenEncrypted = await this.encryption.encrypt(input.accessToken);
    const refreshTokenEncrypted =
      input.refreshToken !== undefined
        ? await this.encryption.encrypt(input.refreshToken)
        : undefined;

    const existing = await this.connections.findByUserIdAndProvider(
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
      const patch: Partial<Connection> = {
        ...baseRow,
        refreshTokenEncrypted:
          refreshTokenEncrypted !== undefined
            ? refreshTokenEncrypted
            : existing.refreshTokenEncrypted,
      };
      return this.connections.update(existing.id, patch);
    }

    return this.connections.create({
      ...baseRow,
      refreshTokenEncrypted: refreshTokenEncrypted ?? null,
    });
  }
}
