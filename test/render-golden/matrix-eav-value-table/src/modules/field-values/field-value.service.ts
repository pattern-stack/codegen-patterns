
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { MetadataEntityService } from '@shared/base-classes/metadata-entity-service';
import { FieldValueRepository } from './field-value.repository';
import type {
  FieldValueColumns,
  FieldValueNoInclude,
  FieldValueResult,
} from './field-value.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { field_values, FieldValue } from './field-value.entity';
import { toEavRows, mergeEavRows } from '@shared/eav-helpers';
import type { DrizzleTx } from '@shared/types/drizzle';
import { FieldDefinitionRepository } from '../field-definitions/field-definition.repository';

@Injectable()
export class FieldValueService extends WithAnalytics(
  MetadataEntityService<FieldValueRepository, FieldValue>,
) {
  protected override readonly entityName = 'field_value';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: FieldValueRepository,
    private readonly definitionRepo: FieldDefinitionRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(FieldValueService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<C extends FieldValueColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<never, C>,
  ): Promise<FieldValueResult<FieldValueNoInclude, C> | null> {
    return this.repository.findById<C>(id, opts);
  }

  override findByIds<C extends FieldValueColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<never, C>,
  ): Promise<Array<FieldValueResult<FieldValueNoInclude, C>>> {
    return this.repository.findByIds<C>(ids, opts);
  }

  override list<C extends FieldValueColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof field_values> & ReadOptions<never, C>,
  ): Promise<Array<FieldValueResult<FieldValueNoInclude, C>>> {
    return this.repository.list<C>(listOptions);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from MetadataEntityService:
  //   findById, findByIds, list, count, exists, create, update, delete
  //   findByEntityIdAndType, listByEntityId, listHistoryByEntityId


  /**
   * EAV compound write (task #23) — upserts a bag of dynamic fields onto
   * an owning entity in a single transaction. Resolves field keys to
   * definition ids internally (by reading FieldDefinitionRepository),
   * so use-cases inject only this service. Unknown keys are skipped; the
   * caller is expected to have created the definitions first (auto-create
   * is a later step).
   */
  async upsertFieldsTransactional(
    entityType: string,
    entityId: string,
    userId: string,
    fields: globalThis.Record<string, unknown>,
    tx?: DrizzleTx,
  ): Promise<void> {
    if (!fields || globalThis.Object.keys(fields).length === 0) return;
    const allDefs = await this.definitionRepo.list();
    const defs = allDefs.filter((d) => (d as any).entityType === entityType);
    const defIdByKey = new globalThis.Map(defs.map((d) => [d.key, d.id]));
    const rows = toEavRows(entityId, entityType, userId, fields, defIdByKey);
    if (rows.length === 0) return;
    await this.repository.upsertCurrentValues(rows as Array<globalThis.Partial<FieldValue>>, tx);
  }

  /**
   * EAV paired read (task #23) — returns the current merged `{ key: value }`
   * bag for one owning entity. Resolves definition ids to keys internally.
   */
  async findMergedByEntity(
    entityType: string,
    entityId: string,
  ): Promise<globalThis.Record<string, unknown>> {
    const [rows, allDefs] = await Promise.all([
      this.repository.findByEntityIdAndType(entityId, entityType),
      this.definitionRepo.list(),
    ]);
    const defs = allDefs.filter((d) => (d as any).entityType === entityType);
    const defsById = new globalThis.Map(defs.map((d) => [d.id, { key: d.key }]));
    return mergeEavRows(rows as any, defsById);
  }
}
