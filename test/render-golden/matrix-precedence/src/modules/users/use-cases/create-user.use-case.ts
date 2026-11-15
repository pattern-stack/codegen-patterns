
import { Injectable } from '@nestjs/common';
import { UserService } from '../user.service';
import type { CreateUserDto } from '../dto/create-user.dto';
import type { User } from '../user.entity';

@Injectable()
export class CreateUserUseCase {
  constructor(private readonly service: UserService) {}

  async execute(
    dto: CreateUserDto,
  ): Promise<User> {
    return this.service.create(dto);
  }
}
