/**
 * Storage subsystem — public API
 *
 * Import the protocol and token in use cases:
 * ```typescript
 * import { STORAGE, type IStorageService } from '@shared/subsystems/storage';
 * ```
 *
 * Import the module in AppModule:
 * ```typescript
 * import { StorageModule } from '@shared/subsystems/storage';
 * ```
 */
export type { IStorageService } from './storage.protocol';
export { LocalStorageBackend } from './storage.local-backend';
export { MemoryStorageBackend } from './storage.memory-backend';
export { StorageModule, type StorageModuleOptions } from './storage.module';
export { STORAGE } from './storage.tokens';
