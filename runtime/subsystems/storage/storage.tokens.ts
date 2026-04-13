/**
 * Injection token for the storage service.
 *
 * Usage in use cases:
 * ```typescript
 * constructor(@Inject(STORAGE) private readonly storage: IStorageService) {}
 * ```
 */
export const STORAGE = Symbol('STORAGE');
