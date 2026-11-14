
import { Injectable } from '@nestjs/common';
import { TeamService } from '../team.service';

@Injectable()
export class DeleteTeamUseCase {
  constructor(private readonly service: TeamService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
