
import { Injectable } from '@nestjs/common';
import { ProjectService } from '../project.service';

@Injectable()
export class DeleteProjectUseCase {
  constructor(private readonly service: ProjectService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
