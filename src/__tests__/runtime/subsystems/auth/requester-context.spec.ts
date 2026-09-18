/**
 * RequesterContext boundary tests.
 *
 * Validates that the middleware bridges IUserContext → ambient scope: it runs
 * the downstream handler inside `withRequester(...)` (so `tryGetRequester()`
 * observes the context), falls back gracefully on unresolved requesters, and
 * that `installRequesterContext` no-ops safely when AUTH_USER_CONTEXT is unbound.
 */
import 'reflect-metadata';
import { describe, it, expect, mock } from 'bun:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AUTH_USER_CONTEXT } from '../../../../../runtime/subsystems/auth/auth.tokens';
import {
  makeRequesterContextMiddleware,
  resolveRequesterContext,
  installRequesterContext,
  resolveUserContext,
} from '../../../../../runtime/subsystems/auth/middleware/requester-context';
import { tryGetRequester } from '../../../../../runtime/base-classes/tenant-context';
import type { IUserContext } from '../../../../../runtime/subsystems/auth/protocols/user-context';

@Module({})
class EmptyModule {}

const FAKE_REQ = { headers: { authorization: 'Bearer x' } };

/** Run the middleware once; capture the ambient context observed inside next(). */
function runMiddleware(
  userContext: IUserContext,
  opts?: Parameters<typeof makeRequesterContextMiddleware>[1],
): Promise<{ captured: ReturnType<typeof tryGetRequester>; err: unknown; called: boolean }> {
  const mw = makeRequesterContextMiddleware(userContext, opts);
  return new Promise((resolve) => {
    mw(FAKE_REQ, {}, (err?: unknown) => {
      resolve({ captured: tryGetRequester(), err, called: true });
    });
  });
}

describe('resolveRequesterContext', () => {
  it('derives user scope from getCurrentUserId when resolveRequester is absent', async () => {
    const uc: IUserContext = { getCurrentUserId: async () => 'u1' };
    expect(await resolveRequesterContext(uc, FAKE_REQ)).toEqual({
      userId: 'u1',
      organizationId: null,
    });
  });

  it('prefers resolveRequester when implemented', async () => {
    const ctx = { userId: 'u2', organizationId: 'o1', scope: 'org' as const, orgUserIds: ['u2', 'u3'] };
    const uc: IUserContext = {
      getCurrentUserId: async () => 'u2',
      resolveRequester: async () => ctx,
    };
    expect(await resolveRequesterContext(uc, FAKE_REQ)).toEqual(ctx);
  });

  it('returns undefined when no userId can be determined', async () => {
    const uc: IUserContext = { getCurrentUserId: async () => '' };
    expect(await resolveRequesterContext(uc, FAKE_REQ)).toBeUndefined();
  });

  it('returns undefined when resolveRequester yields an empty userId', async () => {
    const uc: IUserContext = {
      getCurrentUserId: async () => 'ignored',
      resolveRequester: async () => ({ userId: '', organizationId: null }),
    };
    expect(await resolveRequesterContext(uc, FAKE_REQ)).toBeUndefined();
  });
});

describe('makeRequesterContextMiddleware', () => {
  it('runs downstream inside the ambient context (user scope)', async () => {
    const uc: IUserContext = { getCurrentUserId: async () => 'u1' };
    const { captured, err } = await runMiddleware(uc);
    expect(err).toBeUndefined();
    expect(captured).toEqual({ userId: 'u1', organizationId: null });
  });

  it('propagates the full org context from resolveRequester', async () => {
    const ctx = { userId: 'u2', organizationId: 'o1', scope: 'org' as const, orgUserIds: ['u2'] };
    const uc: IUserContext = {
      getCurrentUserId: async () => 'u2',
      resolveRequester: async () => ctx,
    };
    const { captured } = await runMiddleware(uc);
    expect(captured).toEqual(ctx);
  });

  it('proceeds unscoped (no context) when the requester cannot be resolved', async () => {
    const uc: IUserContext = {
      getCurrentUserId: async () => {
        throw new Error('no token');
      },
    };
    const { captured, err, called } = await runMiddleware(uc);
    expect(called).toBe(true);
    expect(err).toBeUndefined();
    expect(captured).toBeUndefined();
  });

  it('rejects the request when onUnresolved="reject"', async () => {
    const uc: IUserContext = {
      getCurrentUserId: async () => {
        throw new Error('no token');
      },
    };
    const { err } = await runMiddleware(uc, { onUnresolved: 'reject' });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('no token');
  });

  it('does not leak context outside the request (next-less callers stay clean)', () => {
    // Sanity: outside any middleware run, no ambient context is active.
    expect(tryGetRequester()).toBeUndefined();
  });
});

describe('installRequesterContext', () => {
  it('registers the middleware when AUTH_USER_CONTEXT is bound', () => {
    const uc: IUserContext = { getCurrentUserId: async () => 'u1' };
    const use = mock(() => {});
    const app = { get: () => uc, use } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    installRequesterContext(app);
    expect(use).toHaveBeenCalledTimes(1);
  });

  it('no-ops (does not call app.use) when AUTH_USER_CONTEXT is unbound', async () => {
    const use = mock(() => {});
    // A real HTTP app, created as the generated main.ts creates it (#651):
    // `app.get(<unbound>, { strict: false })` throws — never a mock that
    // returns undefined.
    const app = await NestFactory.create(EmptyModule, { logger: false, abortOnError: false });
    const spy = Object.assign(Object.create(app), { use });
    installRequesterContext(spy);
    expect(use).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('resolveUserContext (#651)', () => {
  it('returns null for an unbound AUTH_USER_CONTEXT on a real HTTP app', async () => {
    const app = await NestFactory.create(EmptyModule, { logger: false, abortOnError: false });
    expect(resolveUserContext(app)).toBeNull();
    await app.close();
  });

  it('returns the bound IUserContext', async () => {
    const uc: IUserContext = { getCurrentUserId: async () => 'u1' };
    @Module({ providers: [{ provide: AUTH_USER_CONTEXT, useValue: uc }] })
    class Bound {}
    const app = await NestFactory.createApplicationContext(Bound, { logger: false });
    expect(resolveUserContext(app)).toBe(uc);
    await app.close();
  });

  it('propagates any other error', () => {
    const app = { get: () => { throw new Error('boom'); } } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(() => resolveUserContext(app)).toThrow('boom');
  });
});
