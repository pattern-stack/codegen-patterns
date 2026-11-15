
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { TicketRepository } from './ticket.repository';
import type {
  TicketColumns,
  TicketInclude,
  TicketNoInclude,
  TicketResult,
} from './ticket.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { tickets, Ticket } from './ticket.entity';
import { AccountRepository } from '../accounts/account.repository';
import type { Account } from '../accounts/account.entity';
import { UserRepository } from '../users/user.repository';
import type { User } from '../users/user.entity';

@Injectable()
export class TicketService extends WithAnalytics(
  BaseService<TicketRepository, Ticket>,
) {
  protected override readonly entityName = 'ticket';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: TicketRepository,
    private readonly accountRepo: AccountRepository,
    private readonly userRepo: UserRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(TicketService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends TicketInclude = TicketNoInclude, C extends TicketColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<TicketResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends TicketInclude = TicketNoInclude, C extends TicketColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<TicketResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends TicketInclude = TicketNoInclude, C extends TicketColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof tickets> & ReadOptions<W, C>,
  ): Promise<Array<TicketResult<W, C>>> {
    return this.repository.list<W, C>(listOptions);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

  // ═══════════════════════════════════════════════════════════════════════
  // Declarative queries (from queries: block in entity YAML)
  // Pass-through to repository — keeps use-cases on the service layer so
  // cross-cutting concerns (analytics, events) stay uniform.
  // ═══════════════════════════════════════════════════════════════════════

  findByAccountId<W extends TicketInclude = TicketNoInclude, C extends TicketColumns | undefined = undefined>(
    accountId: string,
    opts?: ReadOptions<W, C>,
  ): Promise<Array<TicketResult<W, C>>> {
    return this.repository.findByAccountId<W, C>(accountId, opts);
  }

  findByAssigneeId<W extends TicketInclude = TicketNoInclude, C extends TicketColumns | undefined = undefined>(
    assigneeId: string,
    opts?: ReadOptions<W, C>,
  ): Promise<TicketResult<W, C> | null> {
    return this.repository.findByAssigneeId<W, C>(assigneeId, opts);
  }

  findByTitle<W extends TicketInclude = TicketNoInclude, C extends TicketColumns | undefined = undefined>(
    title: string,
    opts?: ReadOptions<W, C>,
  ): Promise<Array<TicketResult<W, C>>> {
    return this.repository.findByTitle<W, C>(title, opts);
  }

  async findTitlesByAccountId(accountId: string): Promise<string[]> {
    return this.repository.findTitlesByAccountId(accountId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Relationship composition methods (CGP-358b / CGP-62)
  // Two queries, no SQL JOIN.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch the Account parent for this Ticket.
   * Two repo calls: find self by id → find target by FK.
   */
  async account(ticketId: string): Promise<Account | null> {
    const entity = await this.repository.findById(ticketId);
    if (!entity) return null;
    return entity.accountId ? this.accountRepo.findById(entity.accountId) : null;
  }

  /**
   * Fetch the User parent for this Ticket.
   * Two repo calls: find self by id → find target by FK.
   */
  async assignee(ticketId: string): Promise<User | null> {
    const entity = await this.repository.findById(ticketId);
    if (!entity) return null;
    return entity.assigneeId ? this.userRepo.findById(entity.assigneeId) : null;
  }
}
