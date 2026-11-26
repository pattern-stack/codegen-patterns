
import { Injectable, NotFoundException } from '@nestjs/common';
import { ShelfService } from '../shelf.service';
import type { Shelf } from '../shelf.entity';

@Injectable()
export class FindShelfByIdUseCase {
  constructor(private readonly service: ShelfService) {}

  async execute(id: string): Promise<Shelf> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Shelf not found: ${id}`);
    }
    return entity;
  }
}
