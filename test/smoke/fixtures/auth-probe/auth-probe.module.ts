/**
 * Auth-probe module (ADR-043 smoke harness) — copied into the smoke project's
 * `src/` after `subsystem install auth`, then booted over HTTP by
 * `verify-auth-boot.ts`.
 *
 * It exercises the REAL vendored auth runtime end-to-end:
 *   - `AuthModule.forRoot` binds the global `AuthenticatedGuard` (APP_GUARD).
 *   - a dev `IUserContext` resolves a principal from the Authorization header.
 *   - `installRequesterContext` (wired by the verify harness) bridges that
 *     principal into the ALS.
 *
 * The guarded route returns the AMBIENT requester's userId — proving the
 * principal propagated THROUGH the guard into handler-scope ALS context, which
 * is exactly what `BaseRepository.scopePredicate()` reads to scope a query.
 */
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import {
  AuthModule,
  AUTH_USER_CONTEXT,
  Public,
  type IUserContext,
} from '@shared/subsystems/auth';
import { tryGetRequester } from '@shared/base-classes/tenant-context';

interface HeaderCarrier {
  headers?: Record<string, string | string[] | undefined>;
}

/** Dev IUserContext: any Authorization header → a fixed principal; none → unresolved. */
@Injectable()
export class DevUserContext implements IUserContext {
  async getCurrentUserId(req: unknown): Promise<string> {
    const auth = (req as HeaderCarrier)?.headers?.authorization;
    return auth ? 'probe-user' : '';
  }
}

@Controller('probe')
export class ProbeController {
  // Guarded by the global AuthenticatedGuard. Returns the ambient principal so
  // the harness can assert the principal propagated through the guard.
  @Get('guarded')
  guarded(): { userId: string | null } {
    return { userId: tryGetRequester()?.userId ?? null };
  }

  @Public()
  @Get('public')
  pub(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [
    AuthModule.forRoot({ encryptionKey: 'env', oauthStateStore: 'memory' }),
  ],
  providers: [{ provide: AUTH_USER_CONTEXT, useClass: DevUserContext }],
  controllers: [ProbeController],
})
export class AuthProbeModule {}
