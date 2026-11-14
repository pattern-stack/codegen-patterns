
import { Injectable, Inject, Optional, forwardRef } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { MemberRepository } from './member.repository';
import type {
  MemberColumns,
  MemberNoInclude,
  MemberResult,
} from './member.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { members, Member } from './member.entity';
import { MemberSkillService, MemberSkillLinkInput } from '../member-skills/member-skill.service';
import type { MemberSkill } from '../member-skills/member-skill.entity';
import type { Skill } from '../skills/skill.entity';

@Injectable()
export class MemberService extends WithAnalytics(
  BaseService<MemberRepository, Member>,
) {
  protected override readonly entityName = 'member';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: MemberRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(MemberService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<C extends MemberColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<never, C>,
  ): Promise<MemberResult<MemberNoInclude, C> | null> {
    return this.repository.findById<C>(id, opts);
  }

  override findByIds<C extends MemberColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<never, C>,
  ): Promise<Array<MemberResult<MemberNoInclude, C>>> {
    return this.repository.findByIds<C>(ids, opts);
  }

  override list<C extends MemberColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof members> & ReadOptions<never, C>,
  ): Promise<Array<MemberResult<MemberNoInclude, C>>> {
    return this.repository.list<C>(listOptions);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

  // ═══════════════════════════════════════════════════════════════════════
  // Junction fan-out (CGP-60)
  // Delegates to each junction's service; the same association is mirrored
  // on the other parent.
  // ═══════════════════════════════════════════════════════════════════════

  // member_skill — left side, fan-out to Skill
  @Inject(forwardRef(() => MemberSkillService))
  private readonly memberSkillService!: MemberSkillService;

  async attachSkill(
    memberId: string,
    skillId: string,
    link?: MemberSkillLinkInput,
  ): Promise<MemberSkill> {
    return this.memberSkillService.attach(memberId, skillId, link);
  }

  async detachSkill(
    memberId: string,
    skillId: string,
  ): Promise<void> {
    return this.memberSkillService.detach(memberId, skillId);
  }

  async skillsList(
    memberId: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<Array<{ entity: Skill; link: MemberSkill }>> {
    return this.memberSkillService.listAssoc('left', memberId, opts) as Promise<
      Array<{ entity: Skill; link: MemberSkill }>
    >;
  }

  async skillsSetPrimary(
    memberId: string,
    skillId: string,
  ): Promise<void> {
    return this.memberSkillService.setPrimary(memberId, skillId);
  }
}
