/**
 * Storage subsystem — NestJS module factory
 *
 * Register once in AppModule (global: true means all other modules can inject
 * STORAGE without importing StorageModule themselves):
 *
 * ```typescript
 * // app.module.ts
 * @Module({
 *   imports: [
 *     StorageModule.forRoot({ backend: 'local', basePath: './uploads' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Swap to memory backend in tests:
 * ```typescript
 * Test.createTestingModule({
 *   imports: [StorageModule.forRoot({ backend: 'memory' })],
 * });
 * ```
 */
import { type DynamicModule, Module } from '@nestjs/common';
import { LocalStorageBackend } from './storage.local-backend';
import { MemoryStorageBackend } from './storage.memory-backend';
import { STORAGE } from './storage.tokens';

export interface StorageModuleOptions {
  /** Which backend to activate. */
  backend: 'local' | 'memory';
  /**
   * Base path for the local backend (resolved to an absolute path).
   * Ignored when backend is 'memory'. Defaults to `./storage`.
   */
  basePath?: string;
}

@Module({})
export class StorageModule {
  static forRoot(options: StorageModuleOptions = { backend: 'local' }): DynamicModule {
    const provider =
      options.backend === 'local'
        ? {
            provide: STORAGE,
            useFactory: () => new LocalStorageBackend(options.basePath ?? './storage'),
          }
        : {
            provide: STORAGE,
            useClass: MemoryStorageBackend,
          };

    return {
      module: StorageModule,
      global: true,
      providers: [provider],
      exports: [STORAGE],
    };
  }
}
