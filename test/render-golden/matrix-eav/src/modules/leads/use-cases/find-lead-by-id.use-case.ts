
import { Injectable, NotFoundException } from '@nestjs/common';
import { LeadService } from '../lead.service';
import type { Lead } from '../lead.entity';

@Injectable()
export class FindLeadByIdUseCase {
  constructor(private readonly service: LeadService) {}

  async execute(id: string): Promise<Lead> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Lead not found: ${id}`);
    }
    return entity;
  }
}
