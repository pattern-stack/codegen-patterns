/**
 * Integration subsystem — DI tokens
 *
 * String constants (not Symbols) so they match by value across import
 * boundaries — same convention as the events subsystem (`EVENT_BUS`). The
 * jobs subsystem uses Symbols for its analogous tokens; events and integration
 * stay internally consistent with strings.
 *
 * Usage in use cases:
 * ```ts
 * constructor(
 *   @Inject(INTEGRATION_CHANGE_SOURCE) private readonly source: IChangeSource<CanonicalOpportunity>,
 *   @Inject(INTEGRATION_CURSOR_STORE)  private readonly cursors: ICursorStore,
 *   @Inject(INTEGRATION_FIELD_DIFFER)  private readonly differ: IFieldDiffer<CanonicalOpportunity>,
 *   @Inject(INTEGRATION_SINK)          private readonly sink: IIntegrationSink<CanonicalOpportunity>,
 *   @Inject(INTEGRATION_RUN_RECORDER)  private readonly recorder: IIntegrationRunRecorder,
 * ) {}
 * ```
 *
 * Concrete bindings are registered by `IntegrationModule.forRoot(...)` (SYNC-6).
 */

export const INTEGRATION_CHANGE_SOURCE = 'INTEGRATION_CHANGE_SOURCE' as const;
export const INTEGRATION_CURSOR_STORE = 'INTEGRATION_CURSOR_STORE' as const;
export const INTEGRATION_FIELD_DIFFER = 'INTEGRATION_FIELD_DIFFER' as const;
export const INTEGRATION_SINK = 'INTEGRATION_SINK' as const;

/**
 * Run-recorder token (SYNC-5). Backed by `IIntegrationRunRecorder`. Drizzle impl
 * lands in SYNC-4; tests provide inline fakes.
 */
export const INTEGRATION_RUN_RECORDER = 'INTEGRATION_RUN_RECORDER' as const;

/**
 * Injection token for the resolved `IntegrationModuleOptions` object (SYNC-6).
 *
 * Backends that need to observe module configuration (e.g. `multiTenant`
 * flag, pool filters) inject via this token. Provided automatically by
 * `IntegrationModule.forRoot(...)` / `IntegrationModule.forRootAsync(...)`.
 */
export const INTEGRATION_MODULE_OPTIONS = 'INTEGRATION_MODULE_OPTIONS' as const;

/**
 * Injection token for the resolved multi-tenancy flag (SYNC-6).
 *
 * Provided by `IntegrationModule.forRoot(...)` as `options.multiTenant ?? false`.
 * Consumed by `ExecuteIntegrationUseCase` to enforce the tenantId-is-required rule.
 */
export const INTEGRATION_MULTI_TENANT = 'INTEGRATION_MULTI_TENANT' as const;
