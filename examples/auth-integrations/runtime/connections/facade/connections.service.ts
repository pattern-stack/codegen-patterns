import { Inject, Injectable } from '@nestjs/common';
import {
  ENCRYPTION_KEY,
  type IEncryptionKey,
  type ConnectionGrantInput,
} from '@pattern-stack/codegen/runtime/subsystems/auth';
import { ConnectionService } from '../connection.service';
import type { Connection } from '../connection.entity';
import { CreateOrUpdateFromOAuthGrantUseCase } from '../oauth/use-cases/create-or-update-from-oauth-grant.use-case';
import { DisconnectConnectionUseCase } from '../oauth/use-cases/disconnect-connection.use-case';
import { ListUserConnectionsUseCase } from '../oauth/use-cases/list-user-connections.use-case';
import { MarkConnectionRequiresReauthUseCase } from '../oauth/use-cases/mark-connection-requires-reauth.use-case';

/**
 * Decrypted connection shape — used by consumer code that needs to
 * make outbound API calls (frontend never sees this; it's server-side
 * only). Mirrors the auth subsystem's `DecryptedConnection` but is
 * the consumer-facing return type for `findByUserAndProvider`.
 */
export interface DecryptedConnectionRow {
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
 * ConnectionsService — consumer-facing facade over the codegen-emitted
 * `ConnectionService` plus the auth subsystem's `IEncryptionKey`.
 *
 * Wider than the auth subsystem ports (`IConnectionReader`,
 * `IConnectionTokenWriter`, `IConnectionGrantSink`) on purpose: the
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
export class ConnectionsService {
  constructor(
    private readonly connections: ConnectionService,
    @Inject(ENCRYPTION_KEY) private readonly encryption: IEncryptionKey,
    private readonly createOrUpdateUseCase: CreateOrUpdateFromOAuthGrantUseCase,
    private readonly markReauthUseCase: MarkConnectionRequiresReauthUseCase,
    private readonly disconnectUseCase: DisconnectConnectionUseCase,
    private readonly listUseCase: ListUserConnectionsUseCase,
  ) {}

  /**
   * Loads the connection for `(userId, provider)` and returns it with
   * decrypted tokens, or `null` if no row exists. Returns the row even
   * if `status !== 'active'` so callers can distinguish "never
   * connected" from "connected but broken" — gate on `status` yourself.
   */
  async findByUserAndProvider(
    userId: string,
    provider: string,
  ): Promise<DecryptedConnectionRow | null> {
    const row = await this.connections.findByUserIdAndProvider(userId, provider);
    if (!row) return null;
    return this.decrypt(row);
  }

  /**
   * Lists a user's connections newest-first, with ciphertexts stripped.
   * Safe to return to a frontend.
   */
  async listByUser(userId: string): Promise<Array<Omit<Connection, 'accessTokenEncrypted' | 'refreshTokenEncrypted'>>> {
    const rows = await this.listUseCase.execute(userId);
    return rows.map((row) => {
      const { accessTokenEncrypted: _accessTokenEncrypted, refreshTokenEncrypted: _refreshTokenEncrypted, ...safe } = row;
      return safe;
    });
  }

  /**
   * Upserts a freshly-minted OAuth2 grant from the authorize-code
   * callback. Pass-through to `CreateOrUpdateFromOAuthGrantUseCase` —
   * the input shape matches the auth subsystem's `ConnectionGrantInput`
   * exactly so `ConnectionGrantSinkAdapter` can forward without
   * mapping.
   */
  async createOrUpdateFromOAuthGrant(input: ConnectionGrantInput): Promise<void> {
    await this.createOrUpdateUseCase.execute(input);
  }

  /**
   * Flips status to `requires_reauth`. Called from `withAuthRetry`'s
   * broken-connection handler.
   */
  async markRequiresReauth(connectionId: string): Promise<void> {
    await this.markReauthUseCase.execute(connectionId);
  }

  /**
   * User-initiated disconnect. Status → 'revoked', tokens cleared.
   */
  async disconnect(connectionId: string): Promise<void> {
    await this.disconnectUseCase.execute(connectionId);
  }

  /**
   * Decrypts ciphertexts on a raw `Connection` row. Used internally
   * by `findByUserAndProvider` and by `ConnectionReaderAdapter`.
   *
   * Empty access tokens (e.g. revoked rows where the ciphertext was
   * cleared) decrypt to the empty string — matches
   * `DecryptedConnection.accessToken`'s "empty if never granted"
   * contract.
   */
  private async decrypt(row: Connection): Promise<DecryptedConnectionRow> {
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
