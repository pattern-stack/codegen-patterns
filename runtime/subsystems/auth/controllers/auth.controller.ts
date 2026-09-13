/**
 * AuthController — provider-agnostic OAuth2 connect/callback dance.
 *
 * Mounts two routes:
 *   - `GET /auth/:provider/connect?redirect=...` — generates state, builds
 *     the provider's authorize-url, 302-redirects the browser there.
 *   - `GET /auth/:provider/callback?code=...&state=...` — consumes state,
 *     exchanges the code for tokens, hands them to the grant sink, then
 *     302-redirects to the post-connect path.
 *
 * Hexagonal seams:
 *   - `STRATEGY_REGISTRY` (ReadonlyMap<slug, IProviderStrategy>) — dispatch.
 *     Concrete per-provider strategies live consumer-side and contribute
 *     entries via a `useFactory` in the consumer's app module.
 *   - `AUTH_USER_CONTEXT` (IUserContext) — resolves "who is this request"
 *     from the consumer's session/JWT/etc.
 *   - `OAUTH_STATE_STORE` (IOAuthStateStore) — CSRF state minting/consume.
 *   - `AUTH_CONNECTION_GRANT_SINK` (IConnectionGrantSink) — persists the
 *     freshly-minted grant. Adapter lives consumer-side (e.g. the
 *     auth-integrations starter from #285).
 *
 * The controller never imports `ConnectionsService` or any other concrete
 * consumer type — it goes through ports only.
 */
import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  AUTH_CONNECTION_GRANT_SINK,
  AUTH_OPTIONS,
  AUTH_USER_CONTEXT,
  OAUTH_STATE_STORE,
  STRATEGY_REGISTRY,
} from '../auth.tokens';
import type { AuthModuleOptions } from '../auth.module';
import type { IOAuthStateStore } from '../protocols/oauth-state-store';
import type { IUserContext } from '../protocols/user-context';
import type {
  IProviderStrategy,
  ProviderStrategyRegistry,
} from '../protocols/provider-strategy';
import type { IConnectionGrantSink } from '../protocols/connection-store';
import { Public } from '../guards/public.decorator';

/**
 * Minimal response surface used by the controller — typed loosely so we
 * don't pull a hard dep on `express` or `fastify`. Both popular HTTP
 * adapters expose `redirect(status, url)`.
 */
interface RedirectingResponse {
  redirect(statusCode: number, url: string): unknown;
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(STRATEGY_REGISTRY)
    private readonly registry: ProviderStrategyRegistry,
    @Inject(AUTH_USER_CONTEXT)
    private readonly userContext: IUserContext,
    @Inject(OAUTH_STATE_STORE)
    private readonly stateStore: IOAuthStateStore,
    @Inject(AUTH_CONNECTION_GRANT_SINK)
    private readonly grantSink: IConnectionGrantSink,
    @Inject(AUTH_OPTIONS)
    private readonly options: AuthModuleOptions,
  ) {}

  @Get(':provider/connect')
  async connect(
    @Param('provider') slug: string,
    @Query('redirect') redirect: string | undefined,
    @Req() req: unknown,
    @Res() res: RedirectingResponse,
  ): Promise<unknown> {
    const strategy = this.requireStrategy(slug);
    const userId = await this.userContext.getCurrentUserId(req);
    const state = await this.stateStore.generate({ userId, redirect });
    const url = strategy.buildAuthorizeUrl({
      state,
      redirectUri: this.redirectUriFor(slug),
    });
    return res.redirect(HttpStatus.FOUND, url);
  }

  // The provider redirects the browser here with no app session — the caller's
  // identity is carried in the signed `state`, consumed below. It must therefore
  // bypass the global AuthenticatedGuard (ADR-043 §2: self-lockout ship-blocker).
  // `connect` deliberately stays guarded: starting a connect flow requires an
  // already-authenticated user (see `getCurrentUserId` above).
  @Public()
  @Get(':provider/callback')
  async callback(
    @Param('provider') slug: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: RedirectingResponse,
  ): Promise<unknown> {
    const strategy = this.requireStrategy(slug);
    if (!code) {
      throw new HttpException(
        `Missing 'code' query param`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!state) {
      throw new HttpException(
        `Missing 'state' query param`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const { userId, redirect } = await this.stateStore.consume(state);
    const tokens = await strategy.exchangeCodeForTokens({
      code,
      redirectUri: this.redirectUriFor(slug),
    });
    await this.grantSink.createOrUpdateFromOAuthGrant({
      userId,
      provider: slug,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      externalAccountId: tokens.externalAccountId,
      providerMetadata: tokens.providerMetadata,
    });
    return res.redirect(
      HttpStatus.FOUND,
      redirect ?? `/settings/connections?connected=${encodeURIComponent(slug)}`,
    );
  }

  private requireStrategy(slug: string): IProviderStrategy {
    const strategy = this.registry.get(slug);
    if (!strategy) {
      throw new HttpException(
        `Unknown provider '${slug}'`,
        HttpStatus.NOT_FOUND,
      );
    }
    return strategy;
  }

  private redirectUriFor(slug: string): string {
    const base = this.options.redirectUriBase;
    if (!base) {
      throw new Error(
        `AuthModule.forRoot: redirectUriBase is required when AuthController is enabled`,
      );
    }
    const trimmed = base.replace(/\/+$/, '');
    return `${trimmed}/auth/${encodeURIComponent(slug)}/callback`;
  }
}
