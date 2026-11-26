
import { Injectable } from '@nestjs/common';
import { ShelfService } from '../shelf.service';
import type { CreateShelfDto } from '../dto/create-shelf.dto';
import type { Shelf } from '../shelf.entity';

@Injectable()
export class CreateShelfUseCase {
  constructor(private readonly service: ShelfService) {}

  async execute(
    dto: CreateShelfDto,
  ): Promise<Shelf> {
    return this.service.create(dto);
  }
}
