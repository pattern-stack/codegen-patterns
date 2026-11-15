
import { Injectable, Inject, Optional, forwardRef } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { SkillRepository } from './skill.repository';
import type {
  SkillColumns,
  SkillNoInclude,
  SkillResult,
} from './skill.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { skills, Skill } from './skill.entity';
import { MemberSkillService, MemberSkillLinkInput } from '../member-skills/member-skill.service';
import type { MemberSkill } from '../member-skills/member-skill.entity';
import type { Member } from '../members/member.entity';

@Injectable()
export class SkillService extends WithAnalytics(
  BaseService<SkillRepository, Skill>,
) {
  protected override readonly entityName = 'skill';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: SkillRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(SkillService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<C extends SkillColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<never, C>,
  ): Promise<SkillResult<SkillNoInclude, C> | null> {
    return this.repository.findById<C>(id, opts);
  }

  override findByIds<C extends SkillColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<never, C>,
  ): Promise<Array<SkillResult<SkillNoInclude, C>>> {
    return this.repository.findByIds<C>(ids, opts);
  }

  override list<C extends SkillColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof skills> & ReadOptions<never, C>,
  ): Promise<Array<SkillResult<SkillNoInclude, C>>> {
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

  // member_skill — right side, fan-out to Member
  @Inject(forwardRef(() => MemberSkillService))
  private readonly memberSkillService!: MemberSkillService;

  async addToMember(
    skillId: string,
    memberId: string,
    link?: MemberSkillLinkInput,
  ): Promise<MemberSkill> {
    return this.memberSkillService.attach(memberId, skillId, link);
  }

  async removeFromMember(
    skillId: string,
    memberId: string,
  ): Promise<void> {
    return this.memberSkillService.detach(memberId, skillId);
  }

  async membersList(
    skillId: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<Array<{ entity: Member; link: MemberSkill }>> {
    return this.memberSkillService.listAssoc('right', skillId, opts) as Promise<
      Array<{ entity: Member; link: MemberSkill }>
    >;
  }

  async membersSetPrimary(
    skillId: string,
    memberId: string,
  ): Promise<void> {
    return this.memberSkillService.setPrimary(memberId, skillId);
  }
}
