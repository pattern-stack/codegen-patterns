import type { Registry } from '../index.ts';
import type { LimiterConfig } from '../ports.ts';

/** Each limiter a registered job names that `config` has no entry for, as `job/step: name`. */
export function limitersUnconfigured(
  registry: Registry,
  config: Readonly<Record<string, LimiterConfig>>,
): string[] {
  return registry
    .list()
    .flatMap((job) =>
      registry
        .describe(job.key)
        .steps.flatMap((s) =>
          s.limiters
            .filter((l) => !Object.hasOwn(config, l.name))
            .map((l) => `${job.key}/${s.name}: ${l.name}`),
        ),
    );
}

/** The boot check: a registered job naming a limiter with no config stops the boot, since its quota would be a guess. */
export function assertLimitersConfigured(
  registry: Registry,
  config: Readonly<Record<string, LimiterConfig>>,
): void {
  const missing = limitersUnconfigured(registry, config);
  if (missing.length)
    throw new Error(
      `job limiters with no config in JOBS_LIMITER_CONFIG: ${missing.join(', ')}`,
    );
}
