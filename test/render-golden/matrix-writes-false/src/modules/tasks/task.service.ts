
import { Injectable, Inject, Optional } from '@nestjs/common';
import { WithAnalytics } from '@shared/base-classes/with-analytics';
import { EVENT_BUS } from '@shared/constants/tokens';
import { BaseService } from '@shared/base-classes/base-service';
import { TaskRepository } from './task.repository';
import type {
  TaskColumns,
  TaskInclude,
  TaskNoInclude,
  TaskResult,
} from './task.repository';
import type { ListOptions, ReadOptions } from '@shared/base-classes/base-repository';
import type { tasks, Task } from './task.entity';
import { ProjectRepository } from '../projects/project.repository';
import type { Project } from '../projects/project.entity';

@Injectable()
export class TaskService extends WithAnalytics(
  BaseService<TaskRepository, Task>,
) {
  protected override readonly entityName = 'task';

  /** Injected by NestJS when EventsModule is registered. */
  @Optional() @Inject(EVENT_BUS)
  protected override eventBus: any = undefined;

  constructor(
    protected override readonly repository: TaskRepository,
    private readonly projectRepo: ProjectRepository,
  ) {
    super(repository);
    // findById / findByIds / list are forwarded below — an override of one on a
    // pattern's service base would never run, so construction throws, naming it.
    this.claimGeneratedReads(TaskService);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // The read surface (READ-1 §7) — pass-through, not composition
  //
  // DELEGATION ONLY: the repository's signatures, forwarded so a use case or the
  // HTTP layer can carry a column mask and an allowlisted include to the
  // one place that executes and scopes it. No join logic, no sibling-repository
  // calls, no navigator — the navigator is REL-3's (#588).
  // ═══════════════════════════════════════════════════════════════════════

  override findById<W extends TaskInclude = TaskNoInclude, C extends TaskColumns | undefined = undefined>(
    id: string,
    opts?: ReadOptions<W, C>,
  ): Promise<TaskResult<W, C> | null> {
    return this.repository.findById<W, C>(id, opts);
  }

  override findByIds<W extends TaskInclude = TaskNoInclude, C extends TaskColumns | undefined = undefined>(
    ids: readonly string[],
    opts?: ReadOptions<W, C>,
  ): Promise<Array<TaskResult<W, C>>> {
    return this.repository.findByIds<W, C>(ids, opts);
  }

  override list<W extends TaskInclude = TaskNoInclude, C extends TaskColumns | undefined = undefined>(
    listOptions?: ListOptions<typeof tasks> & ReadOptions<W, C>,
  ): Promise<Array<TaskResult<W, C>>> {
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

  findByTitle<W extends TaskInclude = TaskNoInclude, C extends TaskColumns | undefined = undefined>(
    title: string,
    opts?: ReadOptions<W, C>,
  ): Promise<Array<TaskResult<W, C>>> {
    return this.repository.findByTitle<W, C>(title, opts);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Relationship composition methods (CGP-358b / CGP-62)
  // Two queries, no SQL JOIN.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch the Project parent for this Task.
   * Two repo calls: find self by id → find target by FK.
   */
  async project(taskId: string): Promise<Project | null> {
    const entity = await this.repository.findById(taskId);
    if (!entity) return null;
    return entity.projectId ? this.projectRepo.findById(entity.projectId) : null;
  }
}
