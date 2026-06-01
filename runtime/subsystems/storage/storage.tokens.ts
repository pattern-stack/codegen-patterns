/**
 * Injection token for the storage service.
 *
 * Usage in use cases:
 * ```typescript
 * constructor(@Inject(STORAGE) private readonly storage: IStorageService) {}
 * ```
 *
 * ADR-037: namespaced `Symbol.for(...)` key (via `tokenKey()`) so the token matches
 * by value across import boundaries (package vs vendored runtime copy).
 */
import { tokenKey } from '../token-key';

export const STORAGE = Symbol.for(tokenKey('storage', 'storage'));
