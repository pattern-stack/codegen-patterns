
import { Injectable, NotFoundException } from '@nestjs/common';
import { MeetingService } from '../meeting.service';
import type {
  MeetingInclude,
  MeetingNoInclude,
  MeetingResult,
} from '../meeting.repository';

@Injectable()
export class FindMeetingByIdUseCase {
  constructor(private readonly service: MeetingService) {}

  /**
   * `include` is a typed include TREE, not a client string — the controller has
   * already resolved `?include=` against the route's allowlist and rejected
   * anything it does not name (REL-2 §5). An internal caller passes the tree
   * directly and gets the exact nested result type back, because `TWith` is
   * inferred at the call site.
   */
  async execute<TWith extends MeetingInclude = MeetingNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<MeetingResult<TWith>> {
    const entity = await this.service.findById<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Meeting not found: ${id}`);
    }
    return entity;
  }
}
