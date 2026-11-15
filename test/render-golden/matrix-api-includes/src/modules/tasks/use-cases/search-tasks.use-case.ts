
import { Injectable } from '@nestjs/common';
import { and, eq, ilike, type SQL } from 'drizzle-orm';
import type { ListQuery, Page } from '@shared/http/page';
import { ListTasksUseCase } from './list-tasks.use-case';
import type { tasks, Task } from '../task.entity';

/** The list query (paging + sort) plus the declared search filters. */
export interface SearchTasksInput extends ListQuery {
  projectId?: string;
  search?: string;
}

/**
 * Filtered search use case — generated from the `queries: - name: search` block.
 *
 * A search is the list with a `where`: it ANDs the declared filters
 * (and an ilike on `title`) and pages through `ListTasksUseCase`,
 * so paging, sort and the `Page<T>` envelope are the list endpoint's own (#744).
 */
@Injectable()
export class SearchTasksUseCase {
  constructor(private readonly listUseCase: ListTasksUseCase) {}

  async execute(searchInput: SearchTasksInput): Promise<Page<Task>> {
    // A ROW FILTER, not a rendered SQL: the list renders it against the table
    // handle its executing path holds — the aliased root on the relational path
    // (READ-1 §4). Built from `t`, never from the imported table.
    const rowFilter = (t: typeof tasks): SQL | undefined => {
      const whereTerms: SQL[] = [];
      if (searchInput.projectId) whereTerms.push(eq(t.projectId, searchInput.projectId));
      if (searchInput.search) whereTerms.push(ilike(t.title, `%${searchInput.search}%`));

      return and(...whereTerms);
    };

    // No declared filter set = no `where`. A row filter that happens to render to nothing is still a defined
    // closure, and a child's list routes on whether a `where` is present (RFC-0006 §8): an empty search must read
    // as the plain list, with its default order, not as a filtered one.
    const hasFilter = [
      Boolean(searchInput.projectId),
      Boolean(searchInput.search),
    ].some(Boolean);

    return this.listUseCase.execute(searchInput, hasFilter ? { where: rowFilter } : {});
  }
}
