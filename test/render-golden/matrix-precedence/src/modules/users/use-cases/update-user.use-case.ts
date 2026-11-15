
import { Injectable } from '@nestjs/common';
import { UserService } from '../user.service';
import type { UpdateUserDto } from '../dto/update-user.dto';
import type { User } from '../user.entity';

@Injectable()
export class UpdateUserUseCase {
  constructor(private readonly service: UserService) {}

  async execute(
    id: string,
    dto: UpdateUserDto,
  ): Promise<User | null> {
    return this.service.update(id, dto);
  }
}
