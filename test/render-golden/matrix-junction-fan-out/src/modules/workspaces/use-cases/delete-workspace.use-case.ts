
import { Injectable } from '@nestjs/common';
import { WorkspaceService } from '../workspace.service';

@Injectable()
export class DeleteWorkspaceUseCase {
  constructor(private readonly service: WorkspaceService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
