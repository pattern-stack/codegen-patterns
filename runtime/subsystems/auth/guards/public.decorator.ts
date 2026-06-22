/**
 * `@Public()` — opt a route OUT of the global `AuthenticatedGuard`.
 *
 * The data plane is closed by default (ADR-043): once `AuthModule.forRoot`
 * binds `AuthenticatedGuard` as an `APP_GUARD`, every route requires a verified
 * ambient principal. A handful of routes genuinely cannot — the ones you call
 * to *obtain* a credential in the first place (OAuth callback, login/register
 * on a consumer's session controller) and liveness/health probes. Mark those,
 * and only those, with `@Public()`.
 *
 * Use sparingly and greppably: every `@Public()` is a hole in the fence, so it
 * should be obvious in review. The guard reads this metadata off the matched
 * handler (and its controller class) via the NestJS `Reflector`.
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/** Opt a route (or whole controller) OUT of the global AuthenticatedGuard. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
