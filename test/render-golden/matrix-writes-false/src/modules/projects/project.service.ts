
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { ProjectRepository } from './project.repository';
import type {
  ProjectColumns,
  ProjectInclude,
  ProjectNoInclude,
  ProjectResult,
} from './project.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { projects, Project } from './project.entity';
import { AccountRepository } from '../accounts/account.repository';
import type { Account } from '../accounts/account.entity';
import { TaskRepository } from '../tasks/task.repository';
import type { Task } from '../tasks/task.entity';

@Injectable()
export class ProjectService extends WithAnalytics(
  BaseService<ProjectRepository, Project>,
) {
  protected override readonly entityName = 'project';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: ProjectRepository,
    private readonly accountRepo: AccountRepository,
    private readonly taskRepo: TaskRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(ProjectService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends ProjectInclude = ProjectNoInclude, C extends ProjectColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<ProjectResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends ProjectInclude = ProjectNoInclude, C extends ProjectColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<ProjectResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends ProjectInclude = ProjectNoInclude, C extends ProjectColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof projects> & ReadOptions<W, C>,
  ): Promise<Array<ProjectResult<W, C>>> {
    return this.repository.list<W, C>(listOptions);
  }

  // Lifecycle events (created/updated/deleted + per-field changes) are emitted
  // automatically by BaseService when the events subsystem is installed.
  //
  // Inherited from BaseService:
  //   findById, findByIds, list, count, exists, create, update, delete

  // ═══════════════════════════════════════════════════════════════════════
  // Relationship composition methods (CGP-358b / CGP-62)
  // Two queries, no SQL JOIN.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch the Account parent for this Project.
   * Two repo calls: find self by id → find target by FK.
   */
  async account(projectId: string): Promise<Account | null> {
    const entity = await this.repository.findById(projectId);
    if (!entity) return null;
    return entity.accountId ? this.accountRepo.findById(entity.accountId) : null;
  }

  /**
   * Fetch tasks for this Project by FK traversal.
   * Single repo call; `limit` caps it (ordered by `id`, so the subset is stable).
   */
  async tasks(projectId: string, opts?: { limit?: number }): Promise<Task[]> {
    return this.taskRepo.findByProjectId(projectId, opts);
  }
}
