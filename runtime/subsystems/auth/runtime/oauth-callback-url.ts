/**
 * The URL a provider redirects the browser back to after an OAuth2 authorize: `<redirectUriBase>/auth/<provider>/callback`.
 *
 * One owner for both hosts (S-2): Nest's `AuthController` builds its `redirect_uri` with it, and the pattern-stack
 * `auth` system's `callbackUrl(provider)` is this over `settings.auth.redirectUriBase`. The authorize request and the
 * code exchange must send the same value, so nothing else builds it.
 */
export function oauthCallbackUrl(redirectUriBase: string, provider: string): string {
  return `${redirectUriBase.replace(/\/+$/, '')}/auth/${encodeURIComponent(provider)}/callback`;
}
