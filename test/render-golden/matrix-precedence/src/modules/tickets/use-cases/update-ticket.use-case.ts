
import { Injectable } from '@nestjs/common';
import { TicketService } from '../ticket.service';
import type { UpdateTicketDto } from '../dto/update-ticket.dto';
import type { Ticket } from '../ticket.entity';

@Injectable()
export class UpdateTicketUseCase {
  constructor(private readonly service: TicketService) {}

  async execute(
    id: string,
    dto: UpdateTicketDto,
  ): Promise<Ticket | null> {
    return this.service.update(id, dto);
  }
}
