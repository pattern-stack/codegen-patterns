
import { Injectable } from '@nestjs/common';
import { LeadService } from '../lead.service';
import type { Lead } from '../lead.entity';

@Injectable()
export class FindLeadByIdWithFieldsUseCase {
  constructor(private readonly service: LeadService) {}

  async execute(
    id: string,
  ): Promise<(Lead & { fields: globalThis.Record<string, unknown> }) | null> {
    return this.service.findByIdWithFields(id);
  }
}
