
import { Injectable } from '@nestjs/common';
import { SyncCursorService } from '../sync-cursor.service';

@Injectable()
export class DeleteSyncCursorUseCase {
  constructor(private readonly service: SyncCursorService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
