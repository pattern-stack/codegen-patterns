/**
 * Analytics subsystem — public API
 *
 * Import the module in AppModule, inject the query port via ANALYTICS_QUERY token.
 */
export type {
  ResultRow,
  AnalyticsQueryOpts,
  IAnalyticsQuery,
} from './analytics-query.protocol';
export { ANALYTICS_QUERY, CUBE_API_URL, CUBE_API_SECRET } from './analytics.tokens';
export { AnalyticsModule } from './analytics.module';
export type { AnalyticsModuleOptions } from './analytics.module';
export { CubeAnalyticsBackend } from './cube-backend';
export { NoopAnalyticsBackend } from './noop-backend';
