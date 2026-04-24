/**
 * Observability reporters — internal `IObservability` consumers
 * (ADR-025, OBS-6).
 *
 * Reporters live under `reporters/` to make the "composer vs. consumer"
 * boundary obvious: files at this level consume the facade, files
 * one directory up *are* the facade. See `.claude/skills/observability/SKILL.md`
 * §Shape and §Do-not.
 *
 * Consumers never import classes from this barrel — reporters are
 * auto-registered by `ObservabilityModule.forRoot()` when enabled via
 * `ObservabilityModuleOptions.reporters`. The barrel is re-exported
 * from the subsystem's root `index.ts` so tests and internal wiring
 * can reference the class by name.
 */
export { BridgeMetricsReporter } from './bridge-metrics.reporter';
