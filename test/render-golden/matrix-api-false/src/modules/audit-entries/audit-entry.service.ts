
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { AuditEntryRepository } from './audit-entry.repository';
import type {
  AuditEntryColumns,
  AuditEntryNoInclude,
  AuditEntryResult,
} from './audit-entry.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { audit_entries, AuditEntry } from './audit-entry.entity';

@Injectable()
export class AuditEntryService extends WithAnalytics(
  BaseService<AuditEntryRepository, AuditEntry>,
) {
  protected override readonly entityName = 'audit_entry';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: AuditEntryRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(AuditEntryService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<C extends AuditEntryColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<never, C>,
  ): Promise<AuditEntryResult<AuditEntryNoInclude, C> | null> {
    return this.repository.findById<C>(id, opts);
  }

  override findByIds<C extends AuditEntryColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<never, C>,
  ): Promise<Array<AuditEntryResult<AuditEntryNoInclude, C>>> {
    return this.repository.findByIds<C>(ids, opts);
  }

  override list<C extends AuditEntryColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof audit_entries> & ReadOptions<never, C>,
  ): Promise<Array<AuditEntryResult<AuditEntryNoInclude, C>>> {
    return this.repository.list<C>(listOptions);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

}
