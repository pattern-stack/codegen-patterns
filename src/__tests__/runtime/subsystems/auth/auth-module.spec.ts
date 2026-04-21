/**
 * AuthModule — DI wiring smoke tests.
 *
 * Verifies that `forRoot()` provides the expected tokens with the expected
 * backends, and that provider overrides work for both encryption-key and
 * oauth-state-store slots.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { AuthModule } from '../../../../../runtime/subsystems/auth/auth.module';
import {
  ENCRYPTION_KEY,
  OAUTH_STATE_STORE,
} from '../../../../../runtime/subsystems/auth/auth.tokens';
import { EnvEncryptionKey } from '../../../../../runtime/subsystems/auth/backends/encryption-key/env';
import { InMemoryOAuthStateStore } from '../../../../../runtime/subsystems/auth/backends/oauth-state-store/in-memory';
import type { IEncryptionKey } from '../../../../../runtime/subsystems/auth/protocols/encryption-key';
import type { IOAuthStateStore } from '../../../../../runtime/subsystems/auth/protocols/oauth-state-store';

describe('AuthModule.forRoot', () => {
  const previousKey = process.env['TOKEN_ENCRYPTION_KEY'];

  beforeAll(() => {
    process.env['TOKEN_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env['TOKEN_ENCRYPTION_KEY'];
    else process.env['TOKEN_ENCRYPTION_KEY'] = previousKey;
  });

  it('provides defaults (EnvEncryptionKey + InMemoryOAuthStateStore)', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule.forRoot()],
    }).compile();

    const enc = moduleRef.get<IEncryptionKey>(ENCRYPTION_KEY);
    const store = moduleRef.get<IOAuthStateStore>(OAUTH_STATE_STORE);

    expect(enc).toBeInstanceOf(EnvEncryptionKey);
    expect(store).toBeInstanceOf(InMemoryOAuthStateStore);

    await moduleRef.close();
  });

  it('accepts a custom encryption-key provider', async () => {
    class MyKey implements IEncryptionKey {
      async encrypt(s: string): Promise<string> {
        return `e:${s}`;
      }
      async decrypt(s: string): Promise<string> {
        return s.replace(/^e:/, '');
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthModule.forRoot({
          encryptionKey: { useClass: MyKey },
        }),
      ],
    }).compile();

    const enc = moduleRef.get<IEncryptionKey>(ENCRYPTION_KEY);
    expect(enc).toBeInstanceOf(MyKey);
    expect(await enc.encrypt('x')).toBe('e:x');

    await moduleRef.close();
  });

  it('accepts a custom oauth-state-store provider', async () => {
    class MyStore implements IOAuthStateStore {
      calls = 0;
      async put(): Promise<void> {
        this.calls++;
      }
      async consume(): Promise<null> {
        return null;
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthModule.forRoot({
          oauthStateStore: { useClass: MyStore },
        }),
      ],
    }).compile();

    const store = moduleRef.get<IOAuthStateStore>(OAUTH_STATE_STORE);
    expect(store).toBeInstanceOf(MyStore);

    await moduleRef.close();
  });
});
