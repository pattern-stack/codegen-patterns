/**
 * AuthenticatedGuard — the closed-by-default enforcement point (ADR-043).
 *
 * Bound globally as an `APP_GUARD` by `AuthModule.forRoot` (§2), so it runs on
 * every route with no per-controller wiring. Its job is *authentication* — "is
 * there a verified principal on this request at all" — not authorization (which
 * principal may do what; that stays a consumer concern).
 *
 * ## How it knows
 *
 * It does NOT re-resolve the principal. The single source of truth is the
 * ambient `RequesterContext` that the boundary middleware
 * (`installRequesterContext`, see `../middleware/requester-context`) already
 * established: that middleware runs `withRequester(ctx, ...)` for the rest of
 * the request *iff* the consumer-bound `IUserContext` resolved a verified
 * principal. So inside a handler, `tryGetRequester()` returning a context means
 * "authenticated"; returning `undefined` means "no verified principal".
 *
 * This relies on middleware-runs-before-guard ordering, which holds in NestJS:
 * Express/Fastify middleware executes before route guards.
 *
 * ## The escape hatch
 *
 * Routes that must be reachable unauthenticated — the OAuth callback, a
 * consumer's login/register, health probes — carry `@Public()`. Everything
 * else is guarded. There is deliberately no global off-switch.
 */
import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tryGetRequester } from '../../../base-classes/tenant-context';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class AuthenticatedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    // The boundary middleware ran withRequester(...) iff IUserContext resolved
    // a verified principal. No ambient context here == no authenticated caller.
    if (tryGetRequester()) return true;
    throw new UnauthorizedException();
  }
}
