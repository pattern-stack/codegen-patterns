/**
 * Injection token for the storage service.
 *
 * Usage in use cases:
 * ```typescript
 * constructor(@Inject(STORAGE) private readonly storage: IStorageService) {}
 * ```
 *
 * ADR-037: namespaced `Symbol.for(...)` key so the token matches by value across
 * import boundaries (package vs vendored runtime copy).
 * TODO(token-version): revisit embedding a contract version once codegen/surface
 * versioning is settled.
 */
export const STORAGE = Symbol.for('@pattern-stack/codegen.storage.storage');
