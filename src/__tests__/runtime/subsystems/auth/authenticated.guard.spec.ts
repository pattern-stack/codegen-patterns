/**
 * AuthenticatedGuard — closed-by-default enforcement (ADR-043 §2).
 *
 * Uses the REAL `Reflector` against a `@Public()`-decorated fake controller so
 * the metadata key + getAllAndOverride wiring is exercised end-to-end, and the
 * real `withRequester` ALS to stand in for the boundary middleware.
 *
 * Asserts:
 *   - no ambient context + guarded route → throws UnauthorizedException (401).
 *   - ambient context present + guarded route → passes (the boundary ran).
 *   - `@Public()` route with no context → passes (the escape hatch).
 *   - `@Public()` route with context → passes.
 */
import 'reflect-metadata';
import { describe, it, expect } from 'bun:test';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedGuard } from '../../../../../runtime/subsystems/auth/guards/authenticated.guard';
import {
  Public,
  IS_PUBLIC_KEY,
} from '../../../../../runtime/subsystems/auth/guards/public.decorator';
import { AuthController } from '../../../../../runtime/subsystems/auth/controllers/auth.controller';
import { withRequester } from '../../../../../runtime/base-classes/tenant-context';

class FakeController {
  @Public()
  publicRoute(): void {}

  guardedRoute(): void {}
}

function execContext(
  handler: (...args: unknown[]) => unknown,
  cls: unknown,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

function makeGuard(): AuthenticatedGuard {
  return new AuthenticatedGuard(new Reflector());
}

const controller = new FakeController();
const guardedCtx = execContext(controller.guardedRoute, FakeController);
const publicCtx = execContext(controller.publicRoute, FakeController);

describe('AuthenticatedGuard', () => {
  it('rejects a guarded route with no ambient requester (401)', () => {
    const guard = makeGuard();
    expect(() => guard.canActivate(guardedCtx)).toThrow(UnauthorizedException);
  });

  it('passes a guarded route when an ambient requester is established', async () => {
    const guard = makeGuard();
    const result = await withRequester({ userId: 'u-1', organizationId: null }, async () =>
      guard.canActivate(guardedCtx),
    );
    expect(result).toBe(true);
  });

  it('passes a @Public() route with no ambient requester (the escape hatch)', () => {
    const guard = makeGuard();
    expect(guard.canActivate(publicCtx)).toBe(true);
  });

  it('passes a @Public() route even when a requester is present', async () => {
    const guard = makeGuard();
    const result = await withRequester({ userId: 'u-1', organizationId: null }, async () =>
      guard.canActivate(publicCtx),
    );
    expect(result).toBe(true);
  });
});

describe('AuthController self-lockout fix (ADR-043 §2)', () => {
  const reflector = new Reflector();

  it('marks the OAuth callback @Public() — reachable unauthenticated', () => {
    const isPublic = reflector.get<boolean>(
      IS_PUBLIC_KEY,
      AuthController.prototype.callback,
    );
    expect(isPublic).toBe(true);
  });

  it('keeps connect guarded — it requires an authenticated user', () => {
    const isPublic = reflector.get<boolean>(
      IS_PUBLIC_KEY,
      AuthController.prototype.connect,
    );
    expect(isPublic).toBeFalsy();
  });
});
