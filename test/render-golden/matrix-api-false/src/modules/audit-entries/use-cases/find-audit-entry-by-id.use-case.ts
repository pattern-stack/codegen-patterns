
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditEntryService } from '../audit-entry.service';
import type { AuditEntry } from '../audit-entry.entity';

@Injectable()
export class FindAuditEntryByIdUseCase {
  constructor(private readonly service: AuditEntryService) {}

  async execute(id: string): Promise<AuditEntry> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`AuditEntry not found: ${id}`);
    }
    return entity;
  }
}
