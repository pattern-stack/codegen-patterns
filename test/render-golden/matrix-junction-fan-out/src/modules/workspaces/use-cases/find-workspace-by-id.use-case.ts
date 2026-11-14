
import { Injectable, NotFoundException } from '@nestjs/common';
import { WorkspaceService } from '../workspace.service';
import type { Workspace } from '../workspace.entity';

@Injectable()
export class FindWorkspaceByIdUseCase {
  constructor(private readonly service: WorkspaceService) {}

  async execute(id: string): Promise<Workspace> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Workspace not found: ${id}`);
    }
    return entity;
  }
}
