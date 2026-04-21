/**
 * Sync subsystem — DI tokens
 *
 * String constants (not Symbols) so they match by value across import
 * boundaries — same convention as the events subsystem (`EVENT_BUS`). The
 * jobs subsystem uses Symbols for its analogous tokens; events and sync
 * stay internally consistent with strings.
 *
 * Usage in use cases:
 * ```ts
 * constructor(
 *   @Inject(SYNC_CHANGE_SOURCE) private readonly source: IChangeSource<CanonicalOpportunity>,
 *   @Inject(SYNC_CURSOR_STORE)  private readonly cursors: ICursorStore,
 *   @Inject(SYNC_FIELD_DIFFER)  private readonly differ: IFieldDiffer<CanonicalOpportunity>,
 *   @Inject(SYNC_SINK)          private readonly sink: ISyncSink<CanonicalOpportunity>,
 *   @Inject(SYNC_RUN_RECORDER)  private readonly recorder: ISyncRunRecorder,
 * ) {}
 * ```
 *
 * Concrete bindings are registered by `SyncModule.forRoot(...)` (SYNC-6).
 */

export const SYNC_CHANGE_SOURCE = 'SYNC_CHANGE_SOURCE' as const;
export const SYNC_CURSOR_STORE = 'SYNC_CURSOR_STORE' as const;
export const SYNC_FIELD_DIFFER = 'SYNC_FIELD_DIFFER' as const;
export const SYNC_SINK = 'SYNC_SINK' as const;

/**
 * Run-recorder token (SYNC-5). Backed by `ISyncRunRecorder`. Drizzle impl
 * lands in SYNC-4; tests provide inline fakes.
 */
export const SYNC_RUN_RECORDER = 'SYNC_RUN_RECORDER' as const;

/**
 * Optional loopback-fingerprint store (SYNC-5). Backed by
 * `ILoopbackFingerprintStore<T>`. `ExecuteSyncUseCase` treats this as
 * `@Optional()` — consumers without outbound writeback paths don't need it.
 */
export const SYNC_LOOPBACK_FINGERPRINT_STORE =
  'SYNC_LOOPBACK_FINGERPRINT_STORE' as const;

/**
 * Injection token for the resolved `SyncModuleOptions` object (SYNC-6).
 *
 * Backends that need to observe module configuration (e.g. `multiTenant`
 * flag, pool filters) inject via this token. Provided automatically by
 * `SyncModule.forRoot(...)` / `SyncModule.forRootAsync(...)`.
 */
export const SYNC_MODULE_OPTIONS = 'SYNC_MODULE_OPTIONS' as const;

/**
 * Injection token for the resolved multi-tenancy flag (SYNC-6).
 *
 * Provided by `SyncModule.forRoot(...)` as `options.multiTenant ?? false`.
 * Consumed by `ExecuteSyncUseCase` to enforce the tenantId-is-required rule.
 */
export const SYNC_MULTI_TENANT = 'SYNC_MULTI_TENANT' as const;
