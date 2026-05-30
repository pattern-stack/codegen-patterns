/**
 * Unit tests for `ObservabilityModule` — the combiner subsystem's
 * `DynamicModule.forRoot()` factory (ADR-025, OBS-5).
 *
 * Verifies:
 *   - `forRoot()` returns a `DynamicModule` with `global: true`.
 *   - `OBSERVABILITY` resolves to an `IObservability` implementation
 *     (the sole `ObservabilityService`).
 *   - `OBSERVABILITY_MODULE_OPTIONS` resolves to the passed options.
 *   - Missing siblings → module still boots; every method returns an
 *     empty shape.
 *
 * There is no `backend` option on this module — intentional per ADR-025.
 * The corresponding "backend selection" test that lives on ADR-008
 * subsystems is absent here on purpose.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';

import {
  OBSERVABILITY,
  OBSERVABILITY_MODULE_OPTIONS,
  ObservabilityModule,
  type IObservability,
} from '../../../../runtime/subsystems/observability';
import { ObservabilityService } from '../../../../runtime/subsystems/observability/observability.service';

describe('ObservabilityModule.forRoot() — shape', () => {
  it('returns a DynamicModule with global: true', () => {
    const dyn = ObservabilityModule.forRoot();
    expect(dyn.module).toBe(ObservabilityModule);
    expect(dyn.global).toBe(true);
    // Exports surface is the public API — token + options.
    expect(dyn.exports).toContain(OBSERVABILITY);
    expect(dyn.exports).toContain(OBSERVABILITY_MODULE_OPTIONS);
  });

  it('defaults options to {} when called with no arguments', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule.forRoot()],
    }).compile();

    expect(moduleRef.get(OBSERVABILITY_MODULE_OPTIONS)).toEqual({});
    await moduleRef.close();
  });

  it('stores the passed options under OBSERVABILITY_MODULE_OPTIONS', async () => {
    // Phase-1 ObservabilityModuleOptions is structurally empty, but the
    // factory still has to round-trip whatever it was given so OBS-6 can
    // extend the shape without changing the module.
    const opts = {} as const;
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule.forRoot(opts)],
    }).compile();

    expect(moduleRef.get(OBSERVABILITY_MODULE_OPTIONS)).toBe(opts);
    await moduleRef.close();
  });
});

describe('ObservabilityModule.forRoot() — DI resolution', () => {
  it('resolves OBSERVABILITY to an IObservability implementation (ObservabilityService)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule.forRoot()],
    }).compile();

    const obs = moduleRef.get(OBSERVABILITY);
    expect(obs).toBeInstanceOf(ObservabilityService);

    // Static duck-check on the shape of IObservability — if the class
    // stops implementing the port, the test fails before method calls
    // even execute.
    const typed = obs as IObservability;
    expect(typeof typed.getPoolDepths).toBe('function');
    expect(typeof typed.getRecentFailedJobs).toBe('function');
    expect(typeof typed.getBridgeDeliveryHistogram).toBe('function');
    expect(typeof typed.getRecentIntegrationRuns).toBe('function');
    expect(typeof typed.getCursors).toBe('function');
    await moduleRef.close();
  });

  it('aliases OBSERVABILITY to the same ObservabilityService instance (useExisting)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule.forRoot()],
    }).compile();

    const token = moduleRef.get(OBSERVABILITY);
    const klass = moduleRef.get(ObservabilityService);
    expect(token).toBe(klass); // Same instance — useExisting, not useClass.
    await moduleRef.close();
  });
});

describe('ObservabilityModule.forRoot() — missing siblings', () => {
  // The whole point of the combiner pattern (ADR-025 §Shape constraint 3)
  // is that a consumer can mount this module without first wiring every
  // sibling subsystem. Every method returns an empty shape; nothing throws.

  it('boots with no sibling modules registered', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule.forRoot()],
    }).compile();

    expect(moduleRef.get(OBSERVABILITY)).toBeInstanceOf(ObservabilityService);
    await moduleRef.close();
  });

  it('every IObservability method returns an empty shape', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ObservabilityModule.forRoot()],
    }).compile();

    const obs = moduleRef.get(OBSERVABILITY) as IObservability;

    expect(await obs.getPoolDepths()).toEqual([]);
    expect(await obs.getRecentFailedJobs(10)).toEqual([]);
    expect(await obs.getBridgeDeliveryHistogram(1)).toEqual({
      pending: 0,
      delivered: 0,
      skipped: 0,
      failed: 0,
    });
    expect(await obs.getRecentIntegrationRuns(10)).toEqual([]);
    expect(await obs.getCursors()).toEqual([]);

    await moduleRef.close();
  });
});
