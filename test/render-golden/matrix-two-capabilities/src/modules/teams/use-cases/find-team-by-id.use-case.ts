
import { Injectable, NotFoundException } from '@nestjs/common';
import { TeamService } from '../team.service';
import type {
  TeamInclude,
  TeamNoInclude,
  TeamResult,
} from '../team.repository';

@Injectable()
export class FindTeamByIdUseCase {
  constructor(private readonly service: TeamService) {}

  /**
   * `include` is a typed include TREE, not a client string — the controller has
   * already resolved `?include=` against the route's allowlist and rejected
   * anything it does not name (REL-2 §5). An internal caller passes the tree
   * directly and gets the exact nested result type back, because `TWith` is
   * inferred at the call site.
   */
  async execute<TWith extends TeamInclude = TeamNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<TeamResult<TWith>> {
    const entity = await this.service.findById<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Team not found: ${id}`);
    }
    return entity;
  }
}
