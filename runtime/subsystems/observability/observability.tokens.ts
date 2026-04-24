/**
 * Injection token for the observability service (ADR-008, 5th subsystem).
 *
 * ```typescript
 * constructor(@Inject(OBSERVABILITY) private readonly obs: IObservabilityService) {}
 * ```
 *
 * Per ADR-008, tokens use `Symbol()` for collision avoidance.
 */
export const OBSERVABILITY = Symbol('OBSERVABILITY');

/**
 * Opt-in config token that tells the module whether to register the
 * `BridgeMetricsReporter` sampler. Consumers without the bridge subsystem
 * leave this `false` (the default) so the module doesn't import the
 * reporter's bridge-schema deps.
 */
export const OBSERVABILITY_REPORTERS = Symbol('OBSERVABILITY_REPORTERS');
