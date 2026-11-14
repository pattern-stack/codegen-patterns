
import { Injectable } from '@nestjs/common';
import { CallService } from '../call.service';
import type { CreateCallDto } from '../dto/create-call.dto';
import type { Call } from '../call.entity';

@Injectable()
export class CreateCallUseCase {
  constructor(private readonly service: CallService) {}

  async execute(
    dto: CreateCallDto,
  ): Promise<Call> {
    return this.service.create(dto);
  }
}
