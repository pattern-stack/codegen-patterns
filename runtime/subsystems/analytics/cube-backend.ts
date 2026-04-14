/**
 * CubeAnalyticsBackend — cube.js backend for the analytics query port.
 *
 * Connects to a running cube.js instance via @cubejs-client/core and
 * translates IAnalyticsQuery calls into cube.js query objects.
 *
 * Provided by AnalyticsModule.forRoot({ backend: 'cube' }).
 */
import { Inject, Injectable } from '@nestjs/common';
import cubejs, { type CubejsApi } from '@cubejs-client/core';
import { CUBE_API_URL, CUBE_API_SECRET } from './analytics.tokens';
import type {
  AnalyticsQueryOpts,
  IAnalyticsQuery,
  ResultRow,
} from './analytics-query.protocol';

@Injectable()
export class CubeAnalyticsBackend implements IAnalyticsQuery {
  private readonly cubejsApi: CubejsApi;

  constructor(
    @Inject(CUBE_API_URL) apiUrl: string,
    @Inject(CUBE_API_SECRET) apiSecret: string,
  ) {
    this.cubejsApi = cubejs(apiSecret, { apiUrl });
  }

  async execute(
    cube: string,
    measures: string[],
    dimensions: string[],
    where?: Record<string, any>,
    opts?: AnalyticsQueryOpts,
  ): Promise<ResultRow[]> {
    const query: Record<string, any> = {
      measures: measures.map((m) => cube + '.' + m),
      dimensions: dimensions.map((d) => cube + '.' + d),
    };

    if (where && Object.keys(where).length > 0) {
      query.filters = Object.entries(where).map(([member, value]) => ({
        member: cube + '.' + member,
        operator: 'equals',
        values: Array.isArray(value) ? value : [String(value)],
      }));
    }

    if (opts?.limit) {
      query.limit = opts.limit;
    }

    const resultSet = await this.cubejsApi.load(query);
    return resultSet.tablePivot() as ResultRow[];
  }
}
