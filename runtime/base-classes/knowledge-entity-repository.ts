/**
 * KnowledgeEntityRepository<TEntity, TTable>
 *
 * Stub for the knowledge family (requires pgvector — parked for now).
 * Concrete repos extend this when pgvector is available.
 */
import type { AnyRelations } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { BaseRepository } from './base-repository';

export abstract class KnowledgeEntityRepository<
  TEntity,
  TTable extends PgTable,
  TRelations extends AnyRelations,
> extends BaseRepository<TEntity, TTable, TRelations> {
  // pgvector-dependent methods will be added when the extension is available:
  //   semanticSearch, findPendingByOpportunityId, updateStatus, updateStatusBatch
}
