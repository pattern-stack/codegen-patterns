/**
 * Analytics subsystem unit tests.
 *
 * Tests the NoopAnalyticsBackend (always returns empty arrays) and verifies
 * the IAnalyticsQuery protocol contract. The CubeAnalyticsBackend requires
 * a running cube.js instance and @cubejs-client/core installed — it's tested
 * via integration tests, not here.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { NoopAnalyticsBackend } from '../../../../runtime/subsystems/analytics/noop-backend';
import type { IAnalyticsQuery } from '../../../../runtime/subsystems/analytics/analytics-query.protocol';

// ============================================================================
// NoopAnalyticsBackend
// ============================================================================

describe('NoopAnalyticsBackend', () => {
  let backend: IAnalyticsQuery;

  beforeEach(() => {
    backend = new NoopAnalyticsBackend();
  });

  it('implements IAnalyticsQuery', () => {
    expect(typeof backend.execute).toBe('function');
  });

  it('returns empty array for any query', async () => {
    const result = await backend.execute('Orders', ['totalRevenue'], ['status']);
    expect(result).toEqual([]);
  });

  it('returns empty array with where filters', async () => {
    const result = await backend.execute(
      'Orders',
      ['totalRevenue'],
      ['status'],
      { status: 'active' },
    );
    expect(result).toEqual([]);
  });

  it('returns empty array with opts', async () => {
    const result = await backend.execute(
      'Orders',
      ['count'],
      ['createdAt'],
      undefined,
      { limit: 10, withIds: true },
    );
    expect(result).toEqual([]);
  });

  it('handles empty measures and dimensions', async () => {
    const result = await backend.execute('Orders', [], []);
    expect(result).toEqual([]);
  });

  it('handles multiple measures and dimensions', async () => {
    const result = await backend.execute(
      'Contacts',
      ['count', 'avgDealSize', 'totalRevenue'],
      ['status', 'industry', 'createdAt'],
      { industry: ['tech', 'finance'] },
      { limit: 100 },
    );
    expect(result).toEqual([]);
  });
});

// ============================================================================
// Protocol contract
// ============================================================================

describe('IAnalyticsQuery protocol', () => {
  it('NoopAnalyticsBackend satisfies the protocol shape', () => {
    const backend: IAnalyticsQuery = new NoopAnalyticsBackend();
    // The protocol requires execute() with specific signature
    expect(backend.execute).toBeDefined();
    expect(backend.execute.length).toBeGreaterThanOrEqual(3); // cube, measures, dimensions
  });
});

// ============================================================================
// AnalyticsModule (import shape — no DI container needed)
// ============================================================================

describe('AnalyticsModule', () => {
  it('exports forRoot static method', async () => {
    const { AnalyticsModule } = await import(
      '../../../../runtime/subsystems/analytics/analytics.module'
    );
    expect(typeof AnalyticsModule.forRoot).toBe('function');
  });

  it('forRoot returns a DynamicModule shape for noop', async () => {
    const { AnalyticsModule } = await import(
      '../../../../runtime/subsystems/analytics/analytics.module'
    );
    const mod = AnalyticsModule.forRoot({ backend: 'noop' });
    expect(mod).toHaveProperty('module');
    expect(mod).toHaveProperty('providers');
    expect(mod).toHaveProperty('exports');
    expect(mod.global).toBe(true);
  });

  it('forRoot returns a DynamicModule shape for cube', async () => {
    const { AnalyticsModule } = await import(
      '../../../../runtime/subsystems/analytics/analytics.module'
    );
    const mod = AnalyticsModule.forRoot({ backend: 'cube' });
    expect(mod).toHaveProperty('module');
    expect(mod).toHaveProperty('providers');
    expect(mod).toHaveProperty('exports');
    expect(mod.global).toBe(true);
  });

  it('defaults to noop backend', async () => {
    const { AnalyticsModule } = await import(
      '../../../../runtime/subsystems/analytics/analytics.module'
    );
    const mod = AnalyticsModule.forRoot();
    // noop has fewer providers (no CUBE_API_URL / CUBE_API_SECRET)
    expect(Array.isArray(mod.providers)).toBe(true);
    expect(mod.providers!.length).toBe(1);
  });
});
