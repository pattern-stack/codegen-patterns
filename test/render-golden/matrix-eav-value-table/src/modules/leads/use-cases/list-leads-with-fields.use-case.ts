
import { Injectable } from '@nestjs/common';
import { LeadService } from '../lead.service';
import type { Lead } from '../lead.entity';

@Injectable()
export class ListLeadsWithFieldsUseCase {
  constructor(private readonly service: LeadService) {}

  async execute(): Promise<Array<Lead & { fields: globalThis.Record<string, unknown> }>> {
    return this.service.listWithFields();
  }
}
