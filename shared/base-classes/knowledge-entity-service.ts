/**
 * KnowledgeEntityService<TRepo, TEntity>
 *
 * Stub for the knowledge family (requires pgvector — parked for now).
 */
import { BaseService, type IBaseRepository } from './base-service';

export abstract class KnowledgeEntityService<
  TRepo extends IBaseRepository<TEntity>,
  TEntity,
> extends BaseService<TRepo, TEntity> {
  // pgvector-dependent methods will be added when the extension is available:
  //   semanticSearch, findPendingByOpportunityId, updateStatus, updateStatusBatch
}
