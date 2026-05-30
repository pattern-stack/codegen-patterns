/**
 * Abstract base class for OAuth2 refresh-token strategies.
 *
 * Template-method pattern: `resolve()` is concrete; four small hooks inject
 * provider specifics. Validated across two providers (Salesforce, HubSpot)
 * in the extraction-source app before being extracted here — see
 * `docs/gate-1-auth-extraction-findings.md` for the "build first, extract
 * later" evidence.
 *
 * Subclass contract:
 *   - `provider`                — slug matched against `connections.provider`
 *   - `defaultExpiresInSec`     — fallback when refresh response omits `expires_in`
 *   - `tokenEndpoint()`         — URL to POST the refresh grant
 *   - `refreshBodyExtras()`     — provider-specific body params
 *   - `parseRefreshResponse()`  — raw JSON → ParsedRefreshResponse
 *   - `buildCredentials()`      — stored or freshly-refreshed access token +
 *                                 connection + optional raw refresh response
 *                                 → provider credentials
 *
 * Base handles: expiry check w/ 5-min safety window, `forceRefresh` escape
 * hatch, POST form-urlencoded body, OAuth2 error mapping to
 * `ConnectionBrokenError`, refresh-token rotation persistence, fetch +
 * clock injection for tests.
 */
import type {
  AuthCredentials,
  AuthResolveOptions,
  IAuthStrategy,
} from '../protocols/auth-strategy';
import type {
  DecryptedConnection,
  IConnectionReader,
  IConnectionTokenWriter,
} from '../protocols/connection-store';
import { ConnectionBrokenError } from './connection-broken.error';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Safety window before expiry that triggers a refresh. */
const REFRESH_SAFETY_MS = 5 * 60 * 1000;

export interface OAuth2RefreshStrategyOptions {
  connectionReader: IConnectionReader;
  tokenWriter: IConnectionTokenWriter;
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface ParsedRefreshResponse {
  accessToken: string;
  /**
   * New refresh token if the provider rotated it (HubSpot: always, Salesforce:
   * sometimes). Omit when the provider reused the old refresh token.
   */
  refreshToken?: string;
  /** Seconds from now. If omitted, subclass `defaultExpiresInSec` applies. */
  expiresInSec?: number;
}

export abstract class OAuth2RefreshStrategy implements IAuthStrategy {
  protected abstract readonly provider: string;
  protected abstract readonly defaultExpiresInSec: number;

  protected readonly connectionReader: IConnectionReader;
  protected readonly tokenWriter: IConnectionTokenWriter;
  protected readonly fetchImpl: FetchLike;
  protected readonly now: () => number;

  constructor(opts: OAuth2RefreshStrategyOptions) {
    this.connectionReader = opts.connectionReader;
    this.tokenWriter = opts.tokenWriter;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async resolve(
    connectionId: string,
    opts: AuthResolveOptions = {},
  ): Promise<AuthCredentials> {
    const connection =
      await this.connectionReader.findByIdDecrypted(connectionId);
    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }
    if (connection.provider !== this.provider) {
      throw new Error(
        `${this.constructor.name} called for non-${this.provider} connection ${connectionId} (provider=${connection.provider})`,
      );
    }

    const needsRefresh =
      opts.forceRefresh ||
      this.isExpiring(connection.expiresAt) ||
      !connection.accessToken;

    if (!needsRefresh) {
      return this.buildCredentials(connection.accessToken, connection);
    }

    if (!connection.refreshToken) {
      throw new ConnectionBrokenError(
        connectionId,
        'no_refresh_token',
        'Connection has no refresh token; user must reconnect',
      );
    }

    const { parsed, raw } = await this.executeRefresh(
      connectionId,
      connection.refreshToken,
    );
    const newExpiresAt = new Date(
      this.now() + (parsed.expiresInSec ?? this.defaultExpiresInSec) * 1000,
    );
    await this.tokenWriter.persistRefresh({
      connectionId,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? undefined,
      expiresAt: newExpiresAt,
    });

    return this.buildCredentials(parsed.accessToken, connection, raw);
  }

  protected abstract tokenEndpoint(): string;
  protected abstract refreshBodyExtras(): Record<string, string>;
  protected abstract parseRefreshResponse(raw: unknown): ParsedRefreshResponse;
  protected abstract buildCredentials(
    accessToken: string,
    connection: DecryptedConnection,
    refreshRaw?: unknown,
  ): AuthCredentials;

  private async executeRefresh(
    connectionId: string,
    refreshToken: string,
  ): Promise<{ parsed: ParsedRefreshResponse; raw: unknown }> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...this.refreshBodyExtras(),
    });
    const response = await this.fetchImpl(this.tokenEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      const err = (await safeJson(response)) as Partial<{
        error: string;
        error_description: string;
        message: string;
      }>;
      if (
        response.status === 400 &&
        (err.error === 'invalid_grant' || err.error === 'invalid_token')
      ) {
        throw new ConnectionBrokenError(
          connectionId,
          err.error ?? 'invalid_grant',
          err.error_description ?? err.message ?? 'refresh token rejected',
        );
      }
      throw new Error(
        `${this.provider} token refresh failed: ${response.status} ${err.error ?? ''} ${err.error_description ?? err.message ?? ''}`.trim(),
      );
    }
    const raw = await response.json();
    return { parsed: this.parseRefreshResponse(raw), raw };
  }

  private isExpiring(expiresAt: Date | null): boolean {
    if (!expiresAt) return true;
    return expiresAt.getTime() - this.now() < REFRESH_SAFETY_MS;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return {};
  }
}
