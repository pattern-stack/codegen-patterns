
import { Injectable } from '@nestjs/common';
import { AccountService } from '../account.service';
import type { CreateAccountDto } from '../dto/create-account.dto';
import type { Account } from '../account.entity';

@Injectable()
export class CreateAccountUseCase {
  constructor(private readonly service: AccountService) {}

  async execute(
    dto: CreateAccountDto,
  ): Promise<Account> {
    return this.service.create(dto);
  }
}
