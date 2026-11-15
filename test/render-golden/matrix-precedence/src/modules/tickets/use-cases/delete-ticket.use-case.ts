
import { Injectable } from '@nestjs/common';
import { TicketService } from '../ticket.service';

@Injectable()
export class DeleteTicketUseCase {
  constructor(private readonly service: TicketService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
