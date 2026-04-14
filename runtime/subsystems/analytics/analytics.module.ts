/**
 * AnalyticsModule — DynamicModule factory for the analytics query subsystem.
 *
 * Register once in AppModule:
 * ```typescript
 * @Module({
 *   imports: [
 *     AnalyticsModule.forRoot({ backend: 'cube' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Tests swap to the noop backend without touching application code:
 * ```typescript
 * Test.createTestingModule({
 *   imports: [AnalyticsModule.forRoot({ backend: 'noop' })],
 * });
 * ```
 *
 * `global: true` means entity modules do not need to import AnalyticsModule
 * individually — the ANALYTICS_QUERY token is available project-wide.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { ANALYTICS_QUERY, CUBE_API_URL, CUBE_API_SECRET } from './analytics.tokens';
import { CubeAnalyticsBackend } from './cube-backend';
import { NoopAnalyticsBackend } from './noop-backend';

export interface AnalyticsModuleOptions {
  backend: 'cube' | 'noop';
}

@Module({})
export class AnalyticsModule {
  static forRoot(
    options: AnalyticsModuleOptions = { backend: 'noop' },
  ): DynamicModule {
    if (options.backend === 'cube') {
      return {
        module: AnalyticsModule,
        global: true,
        providers: [
          {
            provide: CUBE_API_URL,
            useValue: process.env['CUBE_API_URL'] ?? 'http://localhost:4000/cubejs-api/v1',
          },
          {
            provide: CUBE_API_SECRET,
            useValue: process.env['CUBE_API_SECRET'] ?? '',
          },
          { provide: ANALYTICS_QUERY, useClass: CubeAnalyticsBackend },
        ],
        exports: [ANALYTICS_QUERY],
      };
    }

    return {
      module: AnalyticsModule,
      global: true,
      providers: [{ provide: ANALYTICS_QUERY, useClass: NoopAnalyticsBackend }],
      exports: [ANALYTICS_QUERY],
    };
  }
}
