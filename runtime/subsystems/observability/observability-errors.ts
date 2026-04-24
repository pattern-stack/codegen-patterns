/**
 * Base class for observability-specific errors.
 *
 * Phase-1 `IObservability` methods do not throw — missing sibling ports
 * degrade to empty shapes (see `ObservabilityService`). This class exists
 * so future extensions (OBS-6 reporter misconfiguration, phase-2 Drizzle
 * extensions for `pg_stat_*` sampling, etc.) have a named base without
 * churning the barrel when they land.
 */
export class ObservabilityError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ObservabilityError';
  }
}
