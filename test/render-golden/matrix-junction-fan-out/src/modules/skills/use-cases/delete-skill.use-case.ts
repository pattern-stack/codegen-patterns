
import { Injectable } from '@nestjs/common';
import { SkillService } from '../skill.service';

@Injectable()
export class DeleteSkillUseCase {
  constructor(private readonly service: SkillService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
