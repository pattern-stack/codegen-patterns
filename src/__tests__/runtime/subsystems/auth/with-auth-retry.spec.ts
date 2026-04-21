/**
 * withAuthRetry — generic retry-once-on-session-expired semantics.
 */
import { describe, it, expect } from 'bun:test';
import { withAuthRetry } from '../../../../../runtime/subsystems/auth/runtime/with-auth-retry';
import { SessionExpiredError } from '../../../../../runtime/subsystems/auth/runtime/session-expired.error';
import type {
  AuthCredentials,
  AuthResolveOptions,
  IAuthStrategy,
} from '../../../../../runtime/subsystems/auth/protocols/auth-strategy';

class FakeStrategy implements IAuthStrategy {
  calls: AuthResolveOptions[] = [];
  constructor(private readonly tokens: string[]) {}
  async resolve(
    _id: string,
    opts: AuthResolveOptions = {},
  ): Promise<AuthCredentials> {
    this.calls.push(opts);
    const token = this.tokens[this.calls.length - 1] ?? this.tokens[this.tokens.length - 1];
    return { accessToken: token! };
  }
}

describe('withAuthRetry', () => {
  it('returns the op result on first success without forcing refresh', async () => {
    const strategy = new FakeStrategy(['t1']);
    const result = await withAuthRetry(strategy, 'int-1', async (creds) => {
      expect(creds.accessToken).toBe('t1');
      return 'done';
    });
    expect(result).toBe('done');
    expect(strategy.calls).toEqual([{}]);
  });

  it('retries once on SessionExpiredError with forceRefresh=true', async () => {
    const strategy = new FakeStrategy(['stale', 'fresh']);
    let attempt = 0;
    const result = await withAuthRetry(strategy, 'int-1', async (creds) => {
      attempt++;
      if (attempt === 1) {
        expect(creds.accessToken).toBe('stale');
        throw new SessionExpiredError();
      }
      expect(creds.accessToken).toBe('fresh');
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(strategy.calls).toEqual([{}, { forceRefresh: true }]);
  });

  it('propagates non-session-expired errors without retrying', async () => {
    const strategy = new FakeStrategy(['t']);
    await expect(
      withAuthRetry(strategy, 'int-1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(strategy.calls).toEqual([{}]);
  });

  it('propagates a second session-expired error (no infinite loop)', async () => {
    const strategy = new FakeStrategy(['a', 'b']);
    await expect(
      withAuthRetry(strategy, 'int-1', async () => {
        throw new SessionExpiredError();
      }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(strategy.calls).toEqual([{}, { forceRefresh: true }]);
  });

  it('recognises errors marked with isSessionExpired=true (duck-typed)', async () => {
    const strategy = new FakeStrategy(['a', 'b']);
    class MySessionExpired extends Error {
      readonly isSessionExpired = true as const;
    }
    let attempt = 0;
    const result = await withAuthRetry(strategy, 'int-1', async () => {
      attempt++;
      if (attempt === 1) throw new MySessionExpired('vendor 401');
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('honours a custom classifier when provided', async () => {
    const strategy = new FakeStrategy(['a', 'b']);
    let attempt = 0;
    class VendorError extends Error {
      constructor(readonly code: number) {
        super('vendor');
      }
    }
    const result = await withAuthRetry(
      strategy,
      'int-1',
      async () => {
        attempt++;
        if (attempt === 1) throw new VendorError(401);
        return 'ok';
      },
      {
        isSessionExpired: (e) => e instanceof VendorError && e.code === 401,
      },
    );
    expect(result).toBe('ok');
    expect(strategy.calls).toEqual([{}, { forceRefresh: true }]);
  });
});
