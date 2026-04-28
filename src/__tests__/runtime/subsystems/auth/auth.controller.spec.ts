/**
 * AuthController — round-trip the connect/callback dance with port stand-ins.
 *
 * Uses a fake `ProviderStrategy` (only the two new connect-flow methods are
 * relevant — the refresh path is exercised by `oauth2-refresh.strategy.spec.ts`),
 * a fake `IUserContext`, the real `MemoryOAuthStateStore`, and a fake
 * `IIntegrationGrantSink` that just captures calls.
 *
 * Asserts:
 *   - `/auth/:provider/connect` 302s to the strategy's authorize URL with a
 *     valid state token.
 *   - `/auth/:provider/callback` consumes the state, calls
 *     `exchangeCodeForTokens`, hands the tokens to the grant sink, and
 *     302s to the original `redirect` from /connect.
 *   - Unknown provider slug → 404.
 *   - Replayed state → throws (state store error).
 */
import 'reflect-metadata';
import { describe, it, expect, mock } from 'bun:test';
import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { AuthController } from '../../../../../runtime/subsystems/auth/controllers/auth.controller';
import { MemoryOAuthStateStore } from '../../../../../runtime/subsystems/auth/backends/state-store.memory-backend';
import {
  AUTH_INTEGRATION_GRANT_SINK,
  AUTH_OPTIONS,
  AUTH_USER_CONTEXT,
  OAUTH_STATE_STORE,
  STRATEGY_REGISTRY,
} from '../../../../../runtime/subsystems/auth/auth.tokens';
import type {
  ExchangedTokens,
  ProviderStrategy,
  ProviderStrategyRegistry,
} from '../../../../../runtime/subsystems/auth/protocols/provider-strategy';
import type { IUserContext } from '../../../../../runtime/subsystems/auth/protocols/user-context';
import type {
  IIntegrationGrantSink,
  IntegrationGrantInput,
} from '../../../../../runtime/subsystems/auth/protocols/integration-store';
import { OAuthStateError } from '../../../../../runtime/subsystems/auth/protocols/oauth-state-store';

interface CapturedRedirect {
  status: number;
  url: string;
}

function makeRes() {
  const captured: CapturedRedirect[] = [];
  const res = {
    redirect: (status: number, url: string) => {
      captured.push({ status, url });
      return undefined;
    },
  };
  return { res, captured };
}

function makeFakeStrategy(slug: string): ProviderStrategy {
  const tokens: ExchangedTokens = {
    accessToken: `at-${slug}`,
    refreshToken: `rt-${slug}`,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    scope: ['read', 'write'],
    externalAccountId: `ext-${slug}`,
    providerMetadata: { source: slug },
  };
  return {
    buildAuthorizeUrl: ({ state, redirectUri }) =>
      `https://auth.${slug}.test/oauth/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCodeForTokens: mock(async (_args: { code: string; redirectUri: string }) => tokens),
    // refresh-path methods are not exercised here; satisfy the interface
    // shape with stubs that throw if called.
    resolve: mock(async () => {
      throw new Error('not used');
    }),
  } as unknown as ProviderStrategy;
}

async function makeController(opts?: {
  registry?: ProviderStrategyRegistry;
  userId?: string;
}) {
  const stateStore = new MemoryOAuthStateStore();
  const userContext: IUserContext = {
    getCurrentUserId: async () => opts?.userId ?? 'user-1',
  };
  const grants: IntegrationGrantInput[] = [];
  const grantSink: IIntegrationGrantSink = {
    createOrUpdateFromOAuthGrant: async (input) => {
      grants.push(input);
    },
  };
  const strategy = makeFakeStrategy('hubspot');
  const registry: ProviderStrategyRegistry =
    opts?.registry ??
    new Map<string, ProviderStrategy>([['hubspot', strategy]]);

  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: STRATEGY_REGISTRY, useValue: registry },
      { provide: AUTH_USER_CONTEXT, useValue: userContext },
      { provide: OAUTH_STATE_STORE, useValue: stateStore },
      { provide: AUTH_INTEGRATION_GRANT_SINK, useValue: grantSink },
      {
        provide: AUTH_OPTIONS,
        useValue: { redirectUriBase: 'https://api.example.test' },
      },
    ],
  }).compile();

  const controller = moduleRef.get(AuthController);
  return { controller, stateStore, grants, strategy, moduleRef };
}

describe('AuthController', () => {
  it('round-trips /connect → /callback end-to-end', async () => {
    const { controller, stateStore, grants } = await makeController();

    // ── /connect ─────────────────────────────────────────────────────────
    const connectRes = makeRes();
    await controller.connect(
      'hubspot',
      '/settings/done',
      {} /* req */,
      connectRes.res,
    );

    expect(connectRes.captured.length).toBe(1);
    const redirect = connectRes.captured[0]!;
    expect(redirect.status).toBe(302);
    expect(redirect.url.startsWith('https://auth.hubspot.test/oauth/authorize?state=')).toBe(true);
    expect(redirect.url).toContain(
      'redirect_uri=https%3A%2F%2Fapi.example.test%2Fauth%2Fhubspot%2Fcallback',
    );

    // Pull the minted state out of the URL so we can hand it back to /callback
    const stateMatch = redirect.url.match(/state=([^&]+)/);
    expect(stateMatch).not.toBeNull();
    const state = decodeURIComponent(stateMatch![1]!);

    // ── /callback ────────────────────────────────────────────────────────
    const cbRes = makeRes();
    await controller.callback('hubspot', 'auth-code-xyz', state, cbRes.res);

    expect(cbRes.captured.length).toBe(1);
    expect(cbRes.captured[0]!.status).toBe(302);
    expect(cbRes.captured[0]!.url).toBe('/settings/done');

    // The grant sink saw the exchanged tokens with the correct user/provider.
    expect(grants.length).toBe(1);
    expect(grants[0]).toEqual({
      userId: 'user-1',
      provider: 'hubspot',
      accessToken: 'at-hubspot',
      refreshToken: 'rt-hubspot',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      scope: ['read', 'write'],
      externalAccountId: 'ext-hubspot',
      providerMetadata: { source: 'hubspot' },
    });

    // State is single-use — a replay must throw.
    await expect(stateStore.consume(state)).rejects.toBeInstanceOf(
      OAuthStateError,
    );
  });

  it('falls back to a default redirect when /connect omitted one', async () => {
    const { controller } = await makeController();
    const connectRes = makeRes();
    await controller.connect('hubspot', undefined, {}, connectRes.res);
    const state = decodeURIComponent(
      connectRes.captured[0]!.url.match(/state=([^&]+)/)![1]!,
    );

    const cbRes = makeRes();
    await controller.callback('hubspot', 'code', state, cbRes.res);
    expect(cbRes.captured[0]!.url).toBe(
      '/settings/integrations?connected=hubspot',
    );
  });

  it('returns 404 for an unknown provider slug', async () => {
    const { controller } = await makeController();
    let caught: unknown;
    try {
      await controller.connect('not-a-provider', undefined, {}, makeRes().res);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(404);
  });

  it('propagates IUserContext failures from /connect', async () => {
    const stateStore = new MemoryOAuthStateStore();
    const userContext: IUserContext = {
      getCurrentUserId: async () => {
        throw new Error('no session');
      },
    };
    const grantSink: IIntegrationGrantSink = {
      createOrUpdateFromOAuthGrant: async () => {},
    };
    const registry: ProviderStrategyRegistry = new Map<string, ProviderStrategy>([
      ['hubspot', makeFakeStrategy('hubspot')],
    ]);
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: STRATEGY_REGISTRY, useValue: registry },
        { provide: AUTH_USER_CONTEXT, useValue: userContext },
        { provide: OAUTH_STATE_STORE, useValue: stateStore },
        { provide: AUTH_INTEGRATION_GRANT_SINK, useValue: grantSink },
        {
          provide: AUTH_OPTIONS,
          useValue: { redirectUriBase: 'https://api.example.test' },
        },
      ],
    }).compile();
    const controller = moduleRef.get(AuthController);

    const res = makeRes();
    await expect(
      controller.connect('hubspot', undefined, {}, res.res),
    ).rejects.toThrow('no session');
    // No state should have been minted, no redirect issued.
    expect(res.captured.length).toBe(0);
  });

  it('rejects /callback when code or state is missing', async () => {
    const { controller } = await makeController();
    let caught: unknown;
    try {
      await controller.callback('hubspot', undefined, 'something', makeRes().res);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(400);
  });
});
