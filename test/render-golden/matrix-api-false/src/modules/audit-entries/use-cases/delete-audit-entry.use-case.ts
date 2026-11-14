
import { Injectable } from '@nestjs/common';
import { AuditEntryService } from '../audit-entry.service';

@Injectable()
export class DeleteAuditEntryUseCase {
  constructor(private readonly service: AuditEntryService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
