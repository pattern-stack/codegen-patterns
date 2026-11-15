
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { ActivityEntityService } from '@shared/base-classes/activity-entity-service';
import { TeamRepository } from './team.repository';
import type {
  TeamColumns,
  TeamInclude,
  TeamNoInclude,
  TeamResult,
} from './team.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { teams, Team } from './team.entity';
import { ContactRepository } from '../contacts/contact.repository';
import type { Contact } from '../contacts/contact.entity';

@Injectable()
export class TeamService extends WithAnalytics(
  ActivityEntityService<TeamRepository, Team>,
) {
  protected override readonly entityName = 'team';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: TeamRepository,
    private readonly contactRepo: ContactRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(TeamService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends TeamInclude = TeamNoInclude, C extends TeamColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<TeamResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends TeamInclude = TeamNoInclude, C extends TeamColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<TeamResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends TeamInclude = TeamNoInclude, C extends TeamColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof teams> & ReadOptions<W, C>,
  ): Promise<Array<TeamResult<W, C>>> {
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
    ...args: globalThis.Parameters<TeamRepository['findByRole']>
  ): globalThis.ReturnType<TeamRepository['findByRole']> {
    return this.repository.findByRole(...args);
  }

  /** Contributed by the `Communication` capability. */
  participants(
    ...args: globalThis.Parameters<TeamRepository['participants']>
  ): globalThis.ReturnType<TeamRepository['participants']> {
    return this.repository.participants(...args);
  }
  // ═══════════════════════════════════════════════════════════════════════
  // Relationship composition methods (CGP-358b / CGP-62)
  // Two queries, no SQL JOIN.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch the Contact parent for this Team.
   * Two repo calls: find self by id → find target by FK.
   */
  async lead(teamId: string): Promise<Contact | null> {
    const entity = await this.repository.findById(teamId);
    if (!entity) return null;
    return entity.leadContactId ? this.contactRepo.findById(entity.leadContactId) : null;
  }
}
