
import { Injectable } from '@nestjs/common';
import { CategoryService } from '../category.service';
import type { UpdateCategoryDto } from '../dto/update-category.dto';
import type { Category } from '../category.entity';

@Injectable()
export class UpdateCategoryUseCase {
  constructor(private readonly service: CategoryService) {}

  async execute(
    id: string,
    dto: UpdateCategoryDto,
  ): Promise<Category | null> {
    return this.service.update(id, dto);
  }
}
