
/**
 * Declarative Query Use Cases for Ticket
 * Generated from queries: block in entity YAML — do not edit directly.
 *
 * Each query is an injectable use case class that delegates to the service.
 * Register all via `declarativeQueryClasses` in the module providers.
 */

import { Injectable } from '@nestjs/common';
import { TicketService } from '../ticket.service';
import type { Ticket } from '../ticket.entity';

@Injectable()
export class FindTicketByAccountIdUseCase {
  constructor(private readonly service: TicketService) {}

  async execute(accountId: string): Promise<Ticket[]> {
    return this.service.findByAccountId(accountId);
  }
}

@Injectable()
export class FindTicketByAssigneeIdUseCase {
  constructor(private readonly service: TicketService) {}

  async execute(assigneeId: string): Promise<Ticket | null> {
    return this.service.findByAssigneeId(assigneeId);
  }
}

@Injectable()
export class FindTicketByTitleUseCase {
  constructor(private readonly service: TicketService) {}

  async execute(title: string): Promise<Ticket[]> {
    return this.service.findByTitle(title);
  }
}

@Injectable()
export class FindTicketTitlesByAccountIdUseCase {
  constructor(private readonly service: TicketService) {}

  async execute(accountId: string): Promise<string[]> {
    return this.service.findTitlesByAccountId(accountId);
  }
}

export const declarativeQueryClasses = [
  FindTicketByAccountIdUseCase,
  FindTicketByAssigneeIdUseCase,
  FindTicketByTitleUseCase,
  FindTicketTitlesByAccountIdUseCase,
];
