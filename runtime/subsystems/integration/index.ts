/**
 * Integration subsystem — public API
 *
 * Slices landed so far:
 *   - SYNC-2 — protocols + DI tokens (#134)
 *   - SYNC-1 — Drizzle audit-table schemas (#148)
 *   - SYNC-3 — MemoryCursorStore (#149)
 *   - SYNC-5 — ExecuteIntegrationUseCase + DeepEqualDiffer + recorder/loopback protocols (#150)
 *   - SYNC-4 — Drizzle backends (#151)
 *   - SYNC-6 — IntegrationModule + MemoryRunRecorder + multi-tenancy opt-in (this slice)
 *
 * Scaffold templates (SYNC-7) and docs/skills (SYNC-8) land in their own
 * PRs. See epic #60.
 */

// The Nest-free half of the API (PW-0): protocols, registry, schemas,
// primitives, tokens, errors.
export * from './core';

// Nest's orchestrator (SYNC-5): IntegrationRunner under DI tokens
export { ExecuteIntegrationUseCase } from './execute-integration.use-case';

// Drizzle backends (SYNC-4)
export { PostgresCursorStore } from './integration-cursor-store.drizzle-backend';
export { DrizzleIntegrationRunRecorder } from './integration-run-recorder.drizzle-backend';

// Module (SYNC-6)
export { IntegrationModule, type IntegrationModuleOptions } from './integration.module';
