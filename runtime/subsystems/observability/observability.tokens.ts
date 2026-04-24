/**
 * Observability combiner subsystem — DI tokens (ADR-025, OBS-5).
 *
 * String constants (not Symbols), matching the events / bridge / sync
 * convention. The jobs subsystem uses Symbols for its analogous tokens;
 * observability stays internally consistent with its sibling combiner
 * (bridge) because the two are structurally paired (ADR-025).
 *
 * Usage in consumers:
 * ```ts
 * constructor(@Inject(OBSERVABILITY) private readonly obs: IObservability) {}
 * ```
 */

/**
 * Token for the `IObservability` composer facade (OBS-5). Resolves to the
 * single `ObservabilityService` instance registered by
 * `ObservabilityModule.forRoot(...)`.
 */
export const OBSERVABILITY = 'OBSERVABILITY' as const;

/**
 * Token for the resolved `ObservabilityModuleOptions` object. Provided by
 * `ObservabilityModule.forRoot(...)`. Reserved for phase 2 — the current
 * options shape is empty; OBS-6 will extend it with a `reporters` field.
 */
export const OBSERVABILITY_MODULE_OPTIONS = 'OBSERVABILITY_MODULE_OPTIONS' as const;
