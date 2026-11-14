
import { Injectable, NotFoundException } from '@nestjs/common';
import { TicketService } from '../ticket.service';
import type {
  TicketInclude,
  TicketNoInclude,
  TicketResult,
} from '../ticket.repository';

@Injectable()
export class FindTicketByIdUseCase {
  constructor(private readonly service: TicketService) {}

  /**
   * `include` is a typed include TREE, not a client string — the controller has
   * already resolved `?include=` against the route's allowlist and rejected
   * anything it does not name (REL-2 §5). An internal caller passes the tree
   * directly and gets the exact nested result type back, because `TWith` is
   * inferred at the call site.
   */
  async execute<TWith extends TicketInclude = TicketNoInclude>(
    id: string,
    include?: TWith,
  ): Promise<TicketResult<TWith>> {
    const entity = await this.service.findById<TWith>(
      id,
      include === undefined ? undefined : { with: include },
    );
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Ticket not found: ${id}`);
    }
    return entity;
  }
}
