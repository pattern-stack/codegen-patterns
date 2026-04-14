/**
 * CubeAnalyticsBackend — cube.js backend for the analytics query port.
 *
 * Connects to a running cube.js instance via @cubejs-client/core and
 * translates IAnalyticsQuery calls into cube.js query objects.
 *
 * @cubejs-client/core is an optional peer dependency; lazy-imported so
 * the module loads even if the package isn't installed. Consumers who
 * use the cube backend must install it separately:
 *   bun add @cubejs-client/core
 *
 * Provided by AnalyticsModule.forRoot({ backend: 'cube' }).
 */
import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { CUBE_API_URL, CUBE_API_SECRET } from './analytics.tokens';
import type {
  AnalyticsQueryOpts,
  IAnalyticsQuery,
  ResultRow,
} from './analytics-query.protocol';

@Injectable()
export class CubeAnalyticsBackend implements IAnalyticsQuery, OnModuleInit {
  private readonly logger = new Logger(CubeAnalyticsBackend.name);
  private cubejsApi: any;

  constructor(
    @Inject(CUBE_API_URL) private readonly apiUrl: string,
    @Inject(CUBE_API_SECRET) private readonly apiSecret: string,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const { default: cubejs } = await import('@cubejs-client/core');
      this.cubejsApi = cubejs(this.apiSecret, { apiUrl: this.apiUrl });
    } catch {
      throw new Error(
        'CubeAnalyticsBackend requires @cubejs-client/core. Install it: bun add @cubejs-client/core',
      );
    }
  }

  async execute(
    cube: string,
    measures: string[],
    dimensions: string[],
    where?: Record<string, any>,
    opts?: AnalyticsQueryOpts,
  ): Promise<ResultRow[]> {
    if (!this.cubejsApi) {
      this.logger.warn('Cube.js client not initialized — returning empty result');
      return [];
    }

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
