/**
 * OAuth2RefreshStrategy — template-method contract test.
 *
 * Uses a fake subclass so each hook can be asserted in isolation without
 * depending on any provider. Mirrors the shape of the SFDC + HubSpot
 * strategies shipped in dealbrain-v2 (Gate-1 extraction source).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  OAuth2RefreshStrategy,
  type OAuth2RefreshStrategyOptions,
  type ParsedRefreshResponse,
} from '../../../../../runtime/subsystems/auth/runtime/oauth2-refresh.strategy';
import { ConnectionBrokenError } from '../../../../../runtime/subsystems/auth/runtime/connection-broken.error';
import type {
  DecryptedConnection,
  IConnectionReader,
  IConnectionTokenWriter,
  ConnectionTokenUpdate,
} from '../../../../../runtime/subsystems/auth/protocols/connection-store';
import type { AuthCredentials } from '../../../../../runtime/subsystems/auth/protocols/auth-strategy';

// ============================================================================
// Fixtures
// ============================================================================

class FakeReader implements IConnectionReader {
  constructor(private readonly row: DecryptedConnection | null) {}
  async findByIdDecrypted(): Promise<DecryptedConnection | null> {
    return this.row;
  }
}

class RecordingWriter implements IConnectionTokenWriter {
  calls: ConnectionTokenUpdate[] = [];
  async persistRefresh(update: ConnectionTokenUpdate): Promise<void> {
    this.calls.push(update);
  }
}

class FakeStrategy extends OAuth2RefreshStrategy {
  protected readonly provider = 'fake';
  protected readonly defaultExpiresInSec = 3600;

  tokenEndpointCalls = 0;
  refreshBodyExtrasCalls = 0;
  parseRefreshCalls = 0;
  buildCredentialsCalls: Array<{
    accessToken: string;
    hasRefreshRaw: boolean;
  }> = [];

  protected tokenEndpoint(): string {
    this.tokenEndpointCalls++;
    return 'https://example.test/oauth/token';
  }

  protected refreshBodyExtras(): Record<string, string> {
    this.refreshBodyExtrasCalls++;
    return { client_id: 'id', client_secret: 'secret' };
  }

  protected parseRefreshResponse(raw: unknown): ParsedRefreshResponse {
    this.parseRefreshCalls++;
    const r = raw as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresInSec: r.expires_in,
    };
  }

  protected buildCredentials(
    accessToken: string,
    connection: DecryptedConnection,
    refreshRaw?: unknown,
  ): AuthCredentials {
    this.buildCredentialsCalls.push({
      accessToken,
      hasRefreshRaw: refreshRaw !== undefined,
    });
    return {
      accessToken,
      orgId: (connection.providerMetadata?.['orgId'] as string) ?? 'org-default',
    };
  }
}

function mockFetch(
  responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  return mock(async (url: string | URL | Request, init?: RequestInit) => {
    return responder(String(url), init);
  });
}

function makeConnection(
  overrides: Partial<DecryptedConnection> = {},
): DecryptedConnection {
  return {
    id: 'int-1',
    provider: 'fake',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    providerMetadata: { orgId: 'org-42' },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('OAuth2RefreshStrategy', () => {
  let fetchFn: ReturnType<typeof mockFetch>;
  let now: number;
  let writer: RecordingWriter;

  beforeEach(() => {
    now = 1_700_000_000_000;
    writer = new RecordingWriter();
    fetchFn = mockFetch(() => new Response(null, { status: 500 }));
  });

  function build(
    reader: IConnectionReader,
    opts: Partial<OAuth2RefreshStrategyOptions> = {},
  ): FakeStrategy {
    return new FakeStrategy({
      connectionReader: reader,
      tokenWriter: writer,
      fetch: fetchFn,
      now: () => now,
      ...opts,
    });
  }

  describe('cache hit', () => {
    it('returns stored token without calling fetch when not expiring', async () => {
      const connection = makeConnection({
        expiresAt: new Date(now + 60 * 60 * 1000),
      });
      const strategy = build(new FakeReader(connection));

      const creds = await strategy.resolve('int-1');

      expect(creds.accessToken).toBe('old-access');
      expect(fetchFn).not.toHaveBeenCalled();
      expect(writer.calls).toHaveLength(0);
      expect(strategy.buildCredentialsCalls).toEqual([
        { accessToken: 'old-access', hasRefreshRaw: false },
      ]);
    });
  });

  describe('force refresh', () => {
    it('bypasses the cache and calls the token endpoint', async () => {
      const connection = makeConnection({
        expiresAt: new Date(now + 60 * 60 * 1000),
      });
      fetchFn = mockFetch(
        () =>
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 7200,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const strategy = build(new FakeReader(connection));

      const creds = await strategy.resolve('int-1', { forceRefresh: true });

      expect(strategy.tokenEndpointCalls).toBe(1);
      expect(strategy.refreshBodyExtrasCalls).toBe(1);
      expect(strategy.parseRefreshCalls).toBe(1);
      expect(creds.accessToken).toBe('new-access');
      expect(writer.calls).toHaveLength(1);
      expect(writer.calls[0]).toMatchObject({
        connectionId: 'int-1',
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      });
    });
  });

  describe('expiring window', () => {
    it('refreshes when the token is inside the 5-minute safety window', async () => {
      // Expires in 1 minute — inside the 5-minute safety window.
      const connection = makeConnection({
        expiresAt: new Date(now + 60 * 1000),
      });
      fetchFn = mockFetch(
        () =>
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const strategy = build(new FakeReader(connection));

      const creds = await strategy.resolve('int-1');
      expect(fetchFn).toHaveBeenCalled();
      expect(creds.accessToken).toBe('new-access');
    });
  });

  describe('refresh body + hook order', () => {
    it('POSTs form-urlencoded with grant_type + refresh_token + extras', async () => {
      const connection = makeConnection({
        expiresAt: new Date(now - 1),
      });
      let capturedBody = '';
      let capturedHeaders: Record<string, string> | undefined;
      fetchFn = mockFetch((_url, init) => {
        capturedBody = (init?.body as string) ?? '';
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return new Response(
          JSON.stringify({ access_token: 'a', expires_in: 60 }),
          { status: 200 },
        );
      });
      const strategy = build(new FakeReader(connection));

      await strategy.resolve('int-1');

      const params = new URLSearchParams(capturedBody);
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('old-refresh');
      expect(params.get('client_id')).toBe('id');
      expect(params.get('client_secret')).toBe('secret');
      expect(capturedHeaders?.['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
    });

    it('passes the raw refresh response to buildCredentials after refresh', async () => {
      const connection = makeConnection({ expiresAt: null });
      fetchFn = mockFetch(
        () =>
          new Response(
            JSON.stringify({ access_token: 'fresh', expires_in: 100 }),
            { status: 200 },
          ),
      );
      const strategy = build(new FakeReader(connection));

      await strategy.resolve('int-1');

      expect(strategy.buildCredentialsCalls).toEqual([
        { accessToken: 'fresh', hasRefreshRaw: true },
      ]);
    });
  });

  describe('refresh-token rotation', () => {
    it('persists the new refresh token when the provider rotates it', async () => {
      const connection = makeConnection({ expiresAt: new Date(now - 1) });
      fetchFn = mockFetch(
        () =>
          new Response(
            JSON.stringify({
              access_token: 'a',
              refresh_token: 'r2',
              expires_in: 60,
            }),
            { status: 200 },
          ),
      );
      const strategy = build(new FakeReader(connection));

      await strategy.resolve('int-1');

      expect(writer.calls[0]?.refreshToken).toBe('r2');
    });

    it('persists refreshToken=undefined when the provider reuses the old one', async () => {
      const connection = makeConnection({ expiresAt: new Date(now - 1) });
      fetchFn = mockFetch(
        () =>
          new Response(
            JSON.stringify({ access_token: 'a', expires_in: 60 }),
            { status: 200 },
          ),
      );
      const strategy = build(new FakeReader(connection));

      await strategy.resolve('int-1');

      expect(writer.calls[0]?.refreshToken).toBeUndefined();
    });
  });

  describe('errors', () => {
    it('throws when the connection is missing', async () => {
      const strategy = build(new FakeReader(null));
      await expect(strategy.resolve('missing')).rejects.toThrow(
        /Connection missing not found/,
      );
    });

    it('throws when the connection provider slug does not match', async () => {
      const connection = makeConnection({ provider: 'other' });
      const strategy = build(new FakeReader(connection));
      await expect(strategy.resolve('int-1')).rejects.toThrow(
        /called for non-fake connection/,
      );
    });

    it('throws ConnectionBrokenError when no refresh token is present', async () => {
      const connection = makeConnection({
        expiresAt: new Date(now - 1),
        refreshToken: null,
      });
      const strategy = build(new FakeReader(connection));
      await expect(strategy.resolve('int-1')).rejects.toBeInstanceOf(
        ConnectionBrokenError,
      );
    });

    it('maps 400 invalid_grant → ConnectionBrokenError', async () => {
      const connection = makeConnection({ expiresAt: new Date(now - 1) });
      fetchFn = mockFetch(
        () =>
          new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'expired or revoked',
            }),
            { status: 400 },
          ),
      );
      const strategy = build(new FakeReader(connection));
      await expect(strategy.resolve('int-1')).rejects.toBeInstanceOf(
        ConnectionBrokenError,
      );
    });

    it('maps 400 invalid_token → ConnectionBrokenError (HubSpot-style)', async () => {
      const connection = makeConnection({ expiresAt: new Date(now - 1) });
      fetchFn = mockFetch(
        () =>
          new Response(JSON.stringify({ error: 'invalid_token' }), {
            status: 400,
          }),
      );
      const strategy = build(new FakeReader(connection));
      await expect(strategy.resolve('int-1')).rejects.toBeInstanceOf(
        ConnectionBrokenError,
      );
    });

    it('wraps non-400 failures with a provider-scoped message', async () => {
      const connection = makeConnection({ expiresAt: new Date(now - 1) });
      fetchFn = mockFetch(
        () =>
          new Response(
            JSON.stringify({ error: 'server_error', error_description: 'oops' }),
            { status: 500 },
          ),
      );
      const strategy = build(new FakeReader(connection));
      await expect(strategy.resolve('int-1')).rejects.toThrow(
        /fake token refresh failed/,
      );
    });
  });

  describe('expiry accounting', () => {
    it('uses subclass defaultExpiresInSec when response omits expires_in', async () => {
      const connection = makeConnection({ expiresAt: new Date(now - 1) });
      fetchFn = mockFetch(
        () =>
          new Response(JSON.stringify({ access_token: 'a' }), { status: 200 }),
      );
      const strategy = build(new FakeReader(connection));

      await strategy.resolve('int-1');

      // Default is 3600s on the fake subclass.
      expect(writer.calls[0]?.expiresAt.getTime()).toBe(now + 3600 * 1000);
    });
  });
});
