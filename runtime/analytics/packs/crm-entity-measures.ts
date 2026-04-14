/**
 * CrmEntityMeasures — measure pack interface for CRM entities.
 *
 * Entities that include the 'crm_entity' measure pack implement this
 * interface on their generated analytics provider.
 */

import type { AnalyticsQueryOpts, ResultRow } from '../../subsystems/analytics/analytics-query.protocol';

export interface CrmEntityMeasures {
  /**
   * Count of active (non-deleted) entities.
   */
  activeCount(opts?: AnalyticsQueryOpts): Promise<ResultRow[]>;

  /**
   * Count of entities created in the last N days.
   */
  createdInLastNDays(n: number, opts?: AnalyticsQueryOpts): Promise<ResultRow[]>;
}
