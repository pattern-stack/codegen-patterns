
import { Injectable, NotFoundException } from '@nestjs/common';
import { ProjectService } from '../project.service';
import type {
  ProjectInclude,
  ProjectNoInclude,
  ProjectResult,
} from '../project.repository';

@Injectable()
export class FindProjectByIdUseCase {
  constructor(private readonly service: ProjectService) {}

  /**
   * `include` is a typed include TREE, not a client string — the controller has
   * already resolved `?include=` against the route's allowlist and rejected
   * anything it does not name (REL-2 §5). An internal caller passes the tree
   * directly and gets the exact nested result type back, because `TWith` is
   * inferred at the call site.
   */
  async execute<TWith extends ProjectInclude = ProjectNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<ProjectResult<TWith>> {
    const entity = await this.service.findById<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Project not found: ${id}`);
    }
    return entity;
  }
}
