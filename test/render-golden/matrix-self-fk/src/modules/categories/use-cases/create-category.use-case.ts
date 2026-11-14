
import { Injectable } from '@nestjs/common';
import { CategoryService } from '../category.service';
import type { CreateCategoryDto } from '../dto/create-category.dto';
import type { Category } from '../category.entity';

@Injectable()
export class CreateCategoryUseCase {
  constructor(private readonly service: CategoryService) {}

  async execute(
    dto: CreateCategoryDto,
  ): Promise<Category> {
    return this.service.create(dto);
  }
}
