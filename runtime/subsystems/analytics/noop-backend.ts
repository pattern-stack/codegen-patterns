/**
 * NoopAnalyticsBackend — no-op backend for the analytics query port.
 *
 * Returns empty arrays for all queries. Use this backend when analytics
 * is disabled or in tests that don't need real analytics data.
 *
 * Provided by AnalyticsModule.forRoot({ backend: 'noop' }).
 */
import { Injectable } from '@nestjs/common';
import type {
  AnalyticsQueryOpts,
  IAnalyticsQuery,
  ResultRow,
} from './analytics-query.protocol';

@Injectable()
export class NoopAnalyticsBackend implements IAnalyticsQuery {
  async execute(
    _cube: string,
    _measures: string[],
    _dimensions: string[],
    _where?: Record<string, any>,
    _opts?: AnalyticsQueryOpts,
  ): Promise<ResultRow[]> {
    return [];
  }
}
