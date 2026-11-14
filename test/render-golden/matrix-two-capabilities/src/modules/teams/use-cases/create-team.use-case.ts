
import { Injectable } from '@nestjs/common';
import { TeamService } from '../team.service';
import type { CreateTeamDto } from '../dto/create-team.dto';
import type { Team } from '../team.entity';

@Injectable()
export class CreateTeamUseCase {
  constructor(private readonly service: TeamService) {}

  async execute(
    dto: CreateTeamDto,
  ): Promise<Team> {
    return this.service.create(dto);
  }
}
