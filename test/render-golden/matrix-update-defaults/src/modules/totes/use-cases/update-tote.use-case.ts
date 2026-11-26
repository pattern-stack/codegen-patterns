
import { Injectable } from '@nestjs/common';
import { ToteService } from '../tote.service';
import type { UpdateToteDto } from '../dto/update-tote.dto';
import type { Tote } from '../tote.entity';

@Injectable()
export class UpdateToteUseCase {
  constructor(private readonly service: ToteService) {}

  async execute(
    id: string,
    dto: UpdateToteDto,
  ): Promise<Tote | null> {
    return this.service.update(id, dto);
  }
}
