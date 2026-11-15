
import { Injectable, NotFoundException } from '@nestjs/common';
import { UserService } from '../user.service';
import type { User } from '../user.entity';

@Injectable()
export class FindUserByIdUseCase {
  constructor(private readonly service: UserService) {}

  async execute(id: string): Promise<User> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`User not found: ${id}`);
    }
    return entity;
  }
}
