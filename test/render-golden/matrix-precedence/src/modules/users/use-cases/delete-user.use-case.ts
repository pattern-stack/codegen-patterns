
import { Injectable } from '@nestjs/common';
import { UserService } from '../user.service';

@Injectable()
export class DeleteUserUseCase {
  constructor(private readonly service: UserService) {}

  async execute(
    id: string,
  ): Promise<void> {
    return this.service.delete(id);
  }
}
