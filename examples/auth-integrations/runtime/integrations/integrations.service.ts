import { Inject, Injectable } from '@nestjs/common';
import {
  ENCRYPTION_KEY,
  type IEncryptionKey,
  type IntegrationGrantInput,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { IntegrationService } from '../../modules/integrations/integration.service';
import type { Integration } from '../../modules/integrations/integration.entity';
import { CreateOrUpdateFromOAuthGrantUseCase } from './use-cases/create-or-update-from-oauth-grant.use-case';
import { DisconnectIntegrationUseCase } from './use-cases/disconnect-integration.use-case';
import { ListUserIntegrationsUseCase } from './use-cases/list-user-integrations.use-case';
import { MarkIntegrationRequiresReauthUseCase } from './use-cases/mark-integration-requires-reauth.use-case';

/**
 * Decrypted integration shape — used by consumer code that needs to
 * make outbound API calls (frontend never sees this; it's server-side
 * only). Mirrors the auth subsystem's `DecryptedIntegration` but is
 * the consumer-facing return type for `findByUserAndProvider`.
 */
export interface DecryptedIntegrationRow {
  id: string;
  userId: string;
  provider: string;
  externalAccountId: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[] | null;
  instanceUrl: string | null;
  providerMetadata: Record<string, unknown> | null;
  status: 'active' | 'requires_reauth' | 'revoked';
  createdAt: Date;
  updatedAt: Date;
}

/**
 * IntegrationsService — consumer-facing facade over the codegen-emitted
 * `IntegrationService` plus the auth subsystem's `IEncryptionKey`.
 *
 * Wider than the auth subsystem ports (`IIntegrationReader`,
 * `IIntegrationTokenWriter`, `IIntegrationGrantSink`) on purpose: the
 * narrow ports are the subsystem's hexagonal seam (so non-codegen
 * consumers can implement them); the facade is what app code talks to
 * directly (controllers, handlers, frontend-facing use cases).
 *
 * Same pattern as EAV's `FieldValueService.upsertFieldsTransactional`
 * being wider than `IFieldValueRepository.upsertCurrentValues`.
 *
 * Ciphertexts never leave the facade in plaintext form except via
 * `findByUserAndProvider` (server-side only — the caller is expected
 * to use the tokens to make an outbound API call). `listByUser`
 * intentionally strips them to a safe metadata shape.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly integrations: IntegrationService,
    @Inject(ENCRYPTION_KEY) private readonly encryption: IEncryptionKey,
    private readonly createOrUpdateUseCase: CreateOrUpdateFromOAuthGrantUseCase,
    private readonly markReauthUseCase: MarkIntegrationRequiresReauthUseCase,
    private readonly disconnectUseCase: DisconnectIntegrationUseCase,
    private readonly listUseCase: ListUserIntegrationsUseCase,
  ) {}

  /**
   * Loads the integration for `(userId, provider)` and returns it with
   * decrypted tokens, or `null` if no row exists. Returns the row even
   * if `status !== 'active'` so callers can distinguish "never
   * connected" from "connected but broken" — gate on `status` yourself.
   */
  async findByUserAndProvider(
    userId: string,
    provider: string,
  ): Promise<DecryptedIntegrationRow | null> {
    const row = await this.integrations.findByUserIdAndProvider(userId, provider);
    if (!row) return null;
    return this.decrypt(row);
  }

  /**
   * Lists a user's integrations newest-first, with ciphertexts stripped.
   * Safe to return to a frontend.
   */
  async listByUser(userId: string): Promise<Array<Omit<Integration, 'accessTokenEncrypted' | 'refreshTokenEncrypted'>>> {
    const rows = await this.listUseCase.execute(userId);
    return rows.map((row) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { accessTokenEncrypted, refreshTokenEncrypted, ...safe } = row;
      return safe;
    });
  }

  /**
   * Upserts a freshly-minted OAuth2 grant from the authorize-code
   * callback. Pass-through to `CreateOrUpdateFromOAuthGrantUseCase` —
   * the input shape matches the auth subsystem's `IntegrationGrantInput`
   * exactly so `IntegrationGrantSinkAdapter` can forward without
   * mapping.
   */
  async createOrUpdateFromOAuthGrant(input: IntegrationGrantInput): Promise<void> {
    await this.createOrUpdateUseCase.execute(input);
  }

  /**
   * Flips status to `requires_reauth`. Called from `withAuthRetry`'s
   * broken-integration handler.
   */
  async markRequiresReauth(integrationId: string): Promise<void> {
    await this.markReauthUseCase.execute(integrationId);
  }

  /**
   * User-initiated disconnect. Status → 'revoked', tokens cleared.
   */
  async disconnect(integrationId: string): Promise<void> {
    await this.disconnectUseCase.execute(integrationId);
  }

  /**
   * Decrypts ciphertexts on a raw `Integration` row. Used internally
   * by `findByUserAndProvider` and by `IntegrationReaderAdapter`.
   *
   * Empty access tokens (e.g. revoked rows where the ciphertext was
   * cleared) decrypt to the empty string — matches
   * `DecryptedIntegration.accessToken`'s "empty if never granted"
   * contract.
   */
  async decrypt(row: Integration): Promise<DecryptedIntegrationRow> {
    const accessToken = row.accessTokenEncrypted
      ? await this.encryption.decrypt(row.accessTokenEncrypted)
      : '';
    const refreshToken = row.refreshTokenEncrypted
      ? await this.encryption.decrypt(row.refreshTokenEncrypted)
      : null;
    return {
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      externalAccountId: row.externalAccountId,
      accessToken,
      refreshToken,
      expiresAt: row.expiresAt,
      scopes: (row.scopes as string[] | null) ?? null,
      instanceUrl: row.instanceUrl,
      providerMetadata: (row.providerMetadata as Record<string, unknown> | null) ?? null,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
