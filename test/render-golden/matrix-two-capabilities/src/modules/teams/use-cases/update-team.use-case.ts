
import { Injectable } from '@nestjs/common';
import { TeamService } from '../team.service';
import type { UpdateTeamDto } from '../dto/update-team.dto';
import type { Team } from '../team.entity';

@Injectable()
export class UpdateTeamUseCase {
  constructor(private readonly service: TeamService) {}

  async execute(
    id: string,
    dto: UpdateTeamDto,
  ): Promise<Team | null> {
    return this.service.update(id, dto);
  }
}
