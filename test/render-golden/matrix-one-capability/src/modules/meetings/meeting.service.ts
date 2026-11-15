
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { ActivityEntityService } from '@shared/base-classes/activity-entity-service';
import { MeetingRepository } from './meeting.repository';
import type {
  MeetingColumns,
  MeetingInclude,
  MeetingNoInclude,
  MeetingResult,
} from './meeting.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { meetings, Meeting } from './meeting.entity';
import { ContactRepository } from '../contacts/contact.repository';
import type { Contact } from '../contacts/contact.entity';

@Injectable()
export class MeetingService extends WithAnalytics(
  ActivityEntityService<MeetingRepository, Meeting>,
) {
  protected override readonly entityName = 'meeting';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: MeetingRepository,
    private readonly contactRepo: ContactRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(MeetingService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends MeetingInclude = MeetingNoInclude, C extends MeetingColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<MeetingResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends MeetingInclude = MeetingNoInclude, C extends MeetingColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<MeetingResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends MeetingInclude = MeetingNoInclude, C extends MeetingColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof meetings> & ReadOptions<W, C>,
  ): Promise<Array<MeetingResult<W, C>>> {
    return this.repository.list<W, C>(listOptions);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from ActivityEntityService:
  //   findById, findByIds, list, count, exists, create, update, delete
  //   findByDateRange, findByUser, findBySubject, findRecent

  // ═══════════════════════════════════════════════════════════════════════
  // Capability forwarders (ADR-041)
  // Pass-through to the repository, where the capability's mixin lives.
  // ═══════════════════════════════════════════════════════════════════════

  /** Contributed by the `Communication` capability. */
  findByRole(
    ...args: globalThis.Parameters<MeetingRepository['findByRole']>
  ): globalThis.ReturnType<MeetingRepository['findByRole']> {
    return this.repository.findByRole(...args);
  }

  /** Contributed by the `Communication` capability. */
  participants(
    ...args: globalThis.Parameters<MeetingRepository['participants']>
  ): globalThis.ReturnType<MeetingRepository['participants']> {
    return this.repository.participants(...args);
  }
  // ═══════════════════════════════════════════════════════════════════════
  // Relationship composition methods (CGP-358b / CGP-62)
  // Two queries, no SQL JOIN.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch the Contact parent for this Meeting.
   * Two repo calls: find self by id → find target by FK.
   */
  async host(meetingId: string): Promise<Contact | null> {
    const entity = await this.repository.findById(meetingId);
    if (!entity) return null;
    return entity.hostContactId ? this.contactRepo.findById(entity.hostContactId) : null;
  }
}
