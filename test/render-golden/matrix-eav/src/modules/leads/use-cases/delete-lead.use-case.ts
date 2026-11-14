
import { Injectable } from '@nestjs/common';
import { LeadService } from '../lead.service';

@Injectable()
export class DeleteLeadUseCase {
  constructor(private readonly service: LeadService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
