/**
 * Env-backed AES-256-GCM encryption.
 *
 * Framing: `base64( nonce(12B) || ciphertext || authTag(16B) )`. Random nonce
 * per call means two encryptions of the same plaintext produce different
 * ciphertexts — prevents replay-style inference. Auth tag enforces integrity;
 * any tampering throws on decrypt.
 *
 * Key source: `INTEGRATION_TOKEN_ENCRYPTION_KEY` env var, 32 bytes base64-encoded.
 * Generate via `openssl rand -base64 32`.
 *
 * Future backend: `kms.ts` (AWS/GCP KMS) for production deployments that
 * need key rotation + audit trails.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { IEncryptionKey } from '../../protocols/encryption-key';

export interface EnvEncryptionKeyOptions {
  /** Defaults to `process.env`. Tests inject a fixture. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `'INTEGRATION_TOKEN_ENCRYPTION_KEY'`. */
  envVar?: string;
}

const ALGO = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class EnvEncryptionKey implements IEncryptionKey {
  private readonly key: Buffer;

  constructor(opts: EnvEncryptionKeyOptions = {}) {
    const env = opts.env ?? process.env;
    const envVar = opts.envVar ?? 'INTEGRATION_TOKEN_ENCRYPTION_KEY';
    const raw = env[envVar];
    if (!raw) {
      throw new Error(
        `EnvEncryptionKey: ${envVar} is not set. Generate with: openssl rand -base64 32`,
      );
    }
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length !== KEY_BYTES) {
      throw new Error(
        `EnvEncryptionKey: ${envVar} must decode to ${KEY_BYTES} bytes (got ${decoded.length}). Use: openssl rand -base64 32`,
      );
    }
    this.key = decoded;
  }

  async encrypt(plaintext: string): Promise<string> {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGO, this.key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([nonce, ciphertext, authTag]).toString('base64');
  }

  async decrypt(ciphertext: string): Promise<string> {
    const buf = Buffer.from(ciphertext, 'base64');
    if (buf.length < NONCE_BYTES + TAG_BYTES) {
      throw new Error('EnvEncryptionKey: ciphertext too short');
    }
    const nonce = buf.subarray(0, NONCE_BYTES);
    const authTag = buf.subarray(buf.length - TAG_BYTES);
    const body = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);

    const decipher = createDecipheriv(ALGO, this.key, nonce);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return plain.toString('utf8');
  }
}
