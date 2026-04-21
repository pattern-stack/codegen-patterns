/**
 * Auth subsystem — `IEncryptionKey` port.
 *
 * Symmetric encryption for secrets at rest (OAuth tokens, API keys).
 * Ciphertexts are opaque strings; implementations embed whatever framing
 * (nonce, auth tag, key version) they need. Callers must not inspect the
 * ciphertext format.
 */
export interface IEncryptionKey {
  /**
   * Encrypt plaintext. Output is a self-contained string that includes any
   * nonce + auth tag the impl needs for decryption. Safe to persist.
   */
  encrypt(plaintext: string): Promise<string>;

  /**
   * Decrypt a ciphertext produced by this impl. Throws on tamper (auth tag
   * mismatch) or malformed input.
   */
  decrypt(ciphertext: string): Promise<string>;
}
