
import { Injectable, Inject, Optional, forwardRef } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { WorkspaceRepository } from './workspace.repository';
import type {
  WorkspaceColumns,
  WorkspaceNoInclude,
  WorkspaceResult,
} from './workspace.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { workspaces, Workspace } from './workspace.entity';
import { WorkspaceMemberService, WorkspaceMemberLinkInput } from '../workspace-members/workspace-member.service';
import type { WorkspaceMember } from '../workspace-members/workspace-member.entity';
import type { Member } from '../members/member.entity';

@Injectable()
export class WorkspaceService extends WithAnalytics(
  BaseService<WorkspaceRepository, Workspace>,
) {
  protected override readonly entityName = 'workspace';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: WorkspaceRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(WorkspaceService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<C extends WorkspaceColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<never, C>,
  ): Promise<WorkspaceResult<WorkspaceNoInclude, C> | null> {
    return this.repository.findById<C>(id, opts);
  }

  override findByIds<C extends WorkspaceColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<never, C>,
  ): Promise<Array<WorkspaceResult<WorkspaceNoInclude, C>>> {
    return this.repository.findByIds<C>(ids, opts);
  }

  override list<C extends WorkspaceColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof workspaces> & ReadOptions<never, C>,
  ): Promise<Array<WorkspaceResult<WorkspaceNoInclude, C>>> {
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

  // workspace_member — left side, fan-out to Member
  @Inject(forwardRef(() => WorkspaceMemberService))
  private readonly workspaceMemberService!: WorkspaceMemberService;

  async attachMember(
    workspaceId: string,
    memberId: string,
    link?: WorkspaceMemberLinkInput,
  ): Promise<WorkspaceMember> {
    return this.workspaceMemberService.attach(workspaceId, memberId, link);
  }

  async detachMember(
    workspaceId: string,
    memberId: string,
  ): Promise<void> {
    return this.workspaceMemberService.detach(workspaceId, memberId);
  }

  async membersList(
    workspaceId: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<Array<{ entity: Member; link: WorkspaceMember }>> {
    return this.workspaceMemberService.listAssoc('left', workspaceId, opts) as Promise<
      Array<{ entity: Member; link: WorkspaceMember }>
    >;
  }
}
