/**
 * Integration subsystem — loopback-fingerprint protocol (port)
 *
 * Optional port. When the local system writes to an upstream provider via an
 * outbound path, the same change typically echoes back on the next inbound
 * poll/CDC/webhook. A fingerprint store lets `ExecuteIntegrationUseCase` skip
 * records it already wrote, avoiding a diff-noop round trip and a spurious
 * audit row.
 *
 * The contract is deliberately narrow: one method, one decision
 * ("is this change an echo of our own recent write?"). Provider-specific
 * fingerprinting (hash a canonical payload, TTL shorter than the poll
 * interval, etc.) lives in the concrete backend. The subsystem does not ship
 * a backend in Phase 1; consumers that need loopback suppression provide
 * their own (redis-hashed, memory TTL, etc.).
 *
 * `entityType` is `string` (not a union) — per HS-9 findings the
 * CRM-specific narrowing `'opportunity' | 'account' | 'contact'` bled into
 * the port and had to be removed. Consumers narrow internally if they want.
 */

export interface ILoopbackFingerprintStore<T = unknown> {
  /**
   * @returns `true` when the record matches a recent local write (skip it)
   *          `false` when the record is external-originated (process it)
   */
  isEchoOfOwnWrite(
    entityType: string,
    externalId: string,
    record: T,
  ): Promise<boolean>;
}
