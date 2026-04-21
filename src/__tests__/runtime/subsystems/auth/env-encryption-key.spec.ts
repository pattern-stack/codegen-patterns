/**
 * EnvEncryptionKey — AES-256-GCM roundtrip + failure-mode tests.
 */
import { describe, it, expect } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { EnvEncryptionKey } from '../../../../../runtime/subsystems/auth/backends/encryption-key/env';

function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
}

describe('EnvEncryptionKey', () => {
  describe('construction', () => {
    it('throws when the env var is missing', () => {
      expect(() => new EnvEncryptionKey({ env: {} })).toThrow(
        /TOKEN_ENCRYPTION_KEY is not set/,
      );
    });

    it('throws when the key is the wrong length', () => {
      expect(
        () =>
          new EnvEncryptionKey({
            env: { TOKEN_ENCRYPTION_KEY: Buffer.from('too short').toString('base64') },
          }),
      ).toThrow(/must decode to 32 bytes/);
    });

    it('accepts a valid 32-byte base64 key', () => {
      const key = new EnvEncryptionKey({ env: fixtureEnv() });
      expect(key).toBeInstanceOf(EnvEncryptionKey);
    });

    it('respects a custom env var name', () => {
      const env: NodeJS.ProcessEnv = {
        MY_CUSTOM_KEY: randomBytes(32).toString('base64'),
      };
      const key = new EnvEncryptionKey({ env, envVar: 'MY_CUSTOM_KEY' });
      expect(key).toBeInstanceOf(EnvEncryptionKey);
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips ASCII plaintext', async () => {
      const key = new EnvEncryptionKey({ env: fixtureEnv() });
      const ct = await key.encrypt('hello world');
      const pt = await key.decrypt(ct);
      expect(pt).toBe('hello world');
    });

    it('round-trips unicode plaintext', async () => {
      const key = new EnvEncryptionKey({ env: fixtureEnv() });
      const plaintext = '你好 🌍 ñoño';
      const ct = await key.encrypt(plaintext);
      expect(await key.decrypt(ct)).toBe(plaintext);
    });

    it('round-trips an empty string', async () => {
      const key = new EnvEncryptionKey({ env: fixtureEnv() });
      const ct = await key.encrypt('');
      expect(await key.decrypt(ct)).toBe('');
    });

    it('produces different ciphertexts for the same plaintext (random nonce)', async () => {
      const key = new EnvEncryptionKey({ env: fixtureEnv() });
      const a = await key.encrypt('same plaintext');
      const b = await key.encrypt('same plaintext');
      expect(a).not.toBe(b);
    });

    it('throws when the ciphertext is too short', async () => {
      const key = new EnvEncryptionKey({ env: fixtureEnv() });
      await expect(key.decrypt(Buffer.from('short').toString('base64'))).rejects.toThrow(
        /ciphertext too short/,
      );
    });

    it('throws on tampered auth tag', async () => {
      const key = new EnvEncryptionKey({ env: fixtureEnv() });
      const ct = await key.encrypt('don’t touch me');
      // Flip the last byte (inside the auth tag region).
      const buf = Buffer.from(ct, 'base64');
      buf[buf.length - 1] ^= 0xff;
      const tampered = buf.toString('base64');
      await expect(key.decrypt(tampered)).rejects.toThrow();
    });

    it('throws when decrypted by a different key', async () => {
      const alice = new EnvEncryptionKey({ env: fixtureEnv() });
      const bob = new EnvEncryptionKey({ env: fixtureEnv() });
      const ct = await alice.encrypt('secret');
      await expect(bob.decrypt(ct)).rejects.toThrow();
    });
  });
});
