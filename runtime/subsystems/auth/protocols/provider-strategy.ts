/**
 * Auth subsystem — `ProviderStrategy` contract.
 *
 * Extension of `OAuth2RefreshStrategy` (which already covers the refresh
 * path) that adds the two methods needed by the connect/callback dance:
 *
 *   - `buildAuthorizeUrl({ state, redirectUri })` → consent-page URL.
 *   - `exchangeCodeForTokens({ code, redirectUri })` → tokens after consent.
 *
 * Concrete per-provider strategies (HubSpot, SFDC, Google, Gong, Fathom, …)
 * stay consumer-side per ADR-031 ("every app has different combinations").
 * They typically subclass `OAuth2RefreshStrategy` for the refresh path and
 * implement these two methods structurally — that satisfies
 * `ProviderStrategy` because TS lets interfaces extend classes by type.
 *
 * AuthController never imports a concrete strategy — it injects the
 * `STRATEGY_REGISTRY` (a `ReadonlyMap<provider-slug, ProviderStrategy>`)
 * and dispatches by slug.
 */
import type { OAuth2RefreshStrategy } from '../runtime/oauth2-refresh.strategy';

export interface ExchangedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string[];
  externalAccountId?: string;
  /** Provider-specific bag (SFDC `instance_url`, Google `sub`, …). */
  providerMetadata?: Record<string, unknown>;
}

export interface ProviderStrategy extends OAuth2RefreshStrategy {
  buildAuthorizeUrl(args: { state: string; redirectUri: string }): string;
  exchangeCodeForTokens(args: {
    code: string;
    redirectUri: string;
  }): Promise<ExchangedTokens>;
}

/** The DI value type behind the `STRATEGY_REGISTRY` token. */
export type ProviderStrategyRegistry = ReadonlyMap<string, ProviderStrategy>;
