/**
 * KnowledgeEntityRepository<TEntity>
 *
 * Stub for the knowledge family (requires pgvector — parked for now).
 * Concrete repos extend this when pgvector is available.
 */
import { BaseRepository } from './base-repository';

export abstract class KnowledgeEntityRepository<TEntity> extends BaseRepository<TEntity> {
  // pgvector-dependent methods will be added when the extension is available:
  //   semanticSearch, findPendingByOpportunityId, updateStatus, updateStatusBatch
}
