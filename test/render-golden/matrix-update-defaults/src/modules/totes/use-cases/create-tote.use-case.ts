
import { Injectable } from '@nestjs/common';
import { ToteService } from '../tote.service';
import type { CreateToteDto } from '../dto/create-tote.dto';
import type { Tote } from '../tote.entity';

@Injectable()
export class CreateToteUseCase {
  constructor(private readonly service: ToteService) {}

  async execute(
    dto: CreateToteDto,
  ): Promise<Tote> {
    return this.service.create(dto);
  }
}
