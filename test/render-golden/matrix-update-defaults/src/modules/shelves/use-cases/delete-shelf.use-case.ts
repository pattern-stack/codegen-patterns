
import { Injectable } from '@nestjs/common';
import { ShelfService } from '../shelf.service';

@Injectable()
export class DeleteShelfUseCase {
  constructor(private readonly service: ShelfService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
