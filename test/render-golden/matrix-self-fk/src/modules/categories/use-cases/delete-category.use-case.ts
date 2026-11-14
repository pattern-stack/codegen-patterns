
import { Injectable } from '@nestjs/common';
import { CategoryService } from '../category.service';

@Injectable()
export class DeleteCategoryUseCase {
  constructor(private readonly service: CategoryService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
