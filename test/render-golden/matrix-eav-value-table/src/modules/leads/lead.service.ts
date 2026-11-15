
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { IntegratedEntityService } from '@shared/base-classes/integrated-entity-service';
import { LeadRepository } from './lead.repository';
import type {
  LeadColumns,
  LeadNoInclude,
  LeadResult,
} from './lead.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { leads, Lead } from './lead.entity';
import { FieldValueService } from '../field-values/field-value.service';

@Injectable()
export class LeadService extends WithAnalytics(
  IntegratedEntityService<LeadRepository, Lead>,
) {
  protected override readonly entityName = 'lead';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: LeadRepository,
    private readonly fieldValues: FieldValueService,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(LeadService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<C extends LeadColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<never, C>,
  ): Promise<LeadResult<LeadNoInclude, C> | null> {
    return this.repository.findById<C>(id, opts);
  }

  override findByIds<C extends LeadColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<never, C>,
  ): Promise<Array<LeadResult<LeadNoInclude, C>>> {
    return this.repository.findByIds<C>(ids, opts);
  }

  override list<C extends LeadColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof leads> & ReadOptions<never, C>,
  ): Promise<Array<LeadResult<LeadNoInclude, C>>> {
    return this.repository.list<C>(listOptions);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from IntegratedEntityService:
  //   findById, findByIds, list, count, exists, create, update, delete
  //   findByExternalId, findManyByExternalIds


  /**
   * EAV paired read (ADR-13): fetch the entity and merge dynamic `field_values`
   * into a single `fields` bag. FieldValueService owns the FieldDefinition
   * lookup internally. Use this for frontend detail views, LLM context,
   * exports.
   */
  async findByIdWithFields(
    id: string,
  ): Promise<(Lead & { fields: globalThis.Record<string, unknown> }) | null> {
    const entity = await this.repository.findById(id);
    if (!entity) return null;
    const fields = await this.fieldValues.findMergedByEntity('lead', id);
    return { ...entity, fields };
  }

  /**
   * EAV paired read (ADR-13): list variant. Fetches all entities then merges
   * each one's EAV fields via FieldValueService. Acceptable for modest result
   * sets; page externally for large collections.
   */
  async listWithFields(): Promise<Array<Lead & { fields: globalThis.Record<string, unknown> }>> {
    const entities = await this.repository.list();
    if (entities.length === 0) return [];
    return Promise.all(
      entities.map(async (entity) => {
        const fields = await this.fieldValues.findMergedByEntity('lead', entity.id);
        return { ...entity, fields };
      }),
    );
  }
}
