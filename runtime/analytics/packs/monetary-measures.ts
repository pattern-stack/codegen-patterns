/**
 * MonetaryMeasures — measure pack interface for revenue / monetary fields.
 *
 * Entities that include the 'monetary' measure pack implement this interface
 * on their generated analytics provider.
 */

import type { AnalyticsQueryOpts, ResultRow } from '../../subsystems/analytics/analytics-query.protocol';

export interface MonetaryMeasures {
  /**
   * Total revenue (sum of the monetary measure).
   */
  totalRevenue(opts?: AnalyticsQueryOpts): Promise<ResultRow[]>;

  /**
   * Revenue broken down by a dimension.
   */
  revenueBy(dimension: string, opts?: AnalyticsQueryOpts): Promise<ResultRow[]>;
}
