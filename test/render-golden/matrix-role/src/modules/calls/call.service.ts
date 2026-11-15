
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { ActivityEntityService } from '@shared/base-classes/activity-entity-service';
import { CallRepository } from './call.repository';
import type {
  CallColumns,
  CallInclude,
  CallNoInclude,
  CallResult,
} from './call.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { calls, Call } from './call.entity';
import { AccountRepository } from '../accounts/account.repository';
import type { Account } from '../accounts/account.entity';
import { ContactRepository } from '../contacts/contact.repository';
import type { Contact } from '../contacts/contact.entity';

@Injectable()
export class CallService extends WithAnalytics(
  ActivityEntityService<CallRepository, Call>,
) {
  protected override readonly entityName = 'call';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: CallRepository,
    private readonly accountRepo: AccountRepository,
    private readonly contactRepo: ContactRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(CallService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends CallInclude = CallNoInclude, C extends CallColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<CallResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends CallInclude = CallNoInclude, C extends CallColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<CallResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends CallInclude = CallNoInclude, C extends CallColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof calls> & ReadOptions<W, C>,
  ): Promise<Array<CallResult<W, C>>> {
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
    ...args: globalThis.Parameters<CallRepository['findByRole']>
  ): globalThis.ReturnType<CallRepository['findByRole']> {
    return this.repository.findByRole(...args);
  }

  /** Contributed by the `Communication` capability. */
  participants(
    ...args: globalThis.Parameters<CallRepository['participants']>
  ): globalThis.ReturnType<CallRepository['participants']> {
    return this.repository.participants(...args);
  }
  // ═══════════════════════════════════════════════════════════════════════
  // Relationship composition methods (CGP-358b / CGP-62)
  // Two queries, no SQL JOIN.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch the Account parent for this Call.
   * Two repo calls: find self by id → find target by FK.
   */
  async account(callId: string): Promise<Account | null> {
    const entity = await this.repository.findById(callId);
    if (!entity) return null;
    return entity.accountId ? this.accountRepo.findById(entity.accountId) : null;
  }

  /**
   * Fetch the Contact parent for this Call.
   * Two repo calls: find self by id → find target by FK.
   */
  async caller(callId: string): Promise<Contact | null> {
    const entity = await this.repository.findById(callId);
    if (!entity) return null;
    return entity.callerId ? this.contactRepo.findById(entity.callerId) : null;
  }

  /**
   * Fetch the Account parent for this Call.
   * Two repo calls: find self by id → find target by FK.
   */
  async regarding(callId: string): Promise<Account | null> {
    const entity = await this.repository.findById(callId);
    if (!entity) return null;
    return entity.regardingAccountId ? this.accountRepo.findById(entity.regardingAccountId) : null;
  }
}
