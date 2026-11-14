
import { Injectable, NotFoundException } from '@nestjs/common';
import { CallService } from '../call.service';
import type {
  CallInclude,
  CallNoInclude,
  CallResult,
} from '../call.repository';

@Injectable()
export class FindCallByIdUseCase {
  constructor(private readonly service: CallService) {}

  /**
   * `include` is a typed include TREE, not a client string — the controller has
   * already resolved `?include=` against the route's allowlist and rejected
   * anything it does not name (REL-2 §5). An internal caller passes the tree
   * directly and gets the exact nested result type back, because `TWith` is
   * inferred at the call site.
   */
  async execute<TWith extends CallInclude = CallNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<CallResult<TWith>> {
    const entity = await this.service.findById<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Call not found: ${id}`);
    }
    return entity;
  }
}
