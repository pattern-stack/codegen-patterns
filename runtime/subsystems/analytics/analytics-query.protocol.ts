/**
 * Analytics subsystem — protocol (port)
 *
 * IAnalyticsQuery is the hexagonal port. Services inject this interface via
 * the ANALYTICS_QUERY token. They never depend on a specific backend
 * implementation (cube.js, noop, etc.).
 */

export interface ResultRow {
  [key: string]: any;
}

export interface AnalyticsQueryOpts {
  /** Include raw entity IDs in the result set. */
  withIds?: boolean;
  /** Maximum number of rows to return. */
  limit?: number;
}

export interface IAnalyticsQuery {
  /**
   * Execute an analytics query against the semantic layer.
   *
   * @param cube - Cube name (e.g., 'Orders')
   * @param measures - Measure names (e.g., ['totalRevenue'])
   * @param dimensions - Dimension names (e.g., ['status', 'createdAt'])
   * @param where - Optional filter conditions
   * @param opts - Query options (limit, withIds)
   */
  execute(
    cube: string,
    measures: string[],
    dimensions: string[],
    where?: Record<string, any>,
    opts?: AnalyticsQueryOpts,
  ): Promise<ResultRow[]>;
}
