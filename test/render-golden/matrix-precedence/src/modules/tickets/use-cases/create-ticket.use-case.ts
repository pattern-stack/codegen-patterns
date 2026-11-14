
import { Injectable } from '@nestjs/common';
import { TicketService } from '../ticket.service';
import type { CreateTicketDto } from '../dto/create-ticket.dto';
import type { Ticket } from '../ticket.entity';

@Injectable()
export class CreateTicketUseCase {
  constructor(private readonly service: TicketService) {}

  async execute(
    dto: CreateTicketDto,
  ): Promise<Ticket> {
    return this.service.create(dto);
  }
}
