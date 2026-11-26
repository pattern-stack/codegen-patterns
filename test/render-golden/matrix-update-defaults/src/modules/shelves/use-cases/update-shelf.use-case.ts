
import { Injectable } from '@nestjs/common';
import { ShelfService } from '../shelf.service';
import type { UpdateShelfDto } from '../dto/update-shelf.dto';
import type { Shelf } from '../shelf.entity';

@Injectable()
export class UpdateShelfUseCase {
  constructor(private readonly service: ShelfService) {}

  async execute(
    id: string,
    dto: UpdateShelfDto,
  ): Promise<Shelf | null> {
    return this.service.update(id, dto);
  }
}
