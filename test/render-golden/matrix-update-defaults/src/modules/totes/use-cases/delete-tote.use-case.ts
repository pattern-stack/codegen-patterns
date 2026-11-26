
import { Injectable } from '@nestjs/common';
import { ToteService } from '../tote.service';

@Injectable()
export class DeleteToteUseCase {
  constructor(private readonly service: ToteService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
