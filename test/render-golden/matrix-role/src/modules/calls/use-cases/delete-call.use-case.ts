
import { Injectable } from '@nestjs/common';
import { CallService } from '../call.service';

@Injectable()
export class DeleteCallUseCase {
  constructor(private readonly service: CallService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
