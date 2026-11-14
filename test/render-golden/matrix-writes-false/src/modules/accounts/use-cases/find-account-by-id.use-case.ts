
import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountService } from '../account.service';
import type { Account } from '../account.entity';

@Injectable()
export class FindAccountByIdUseCase {
  constructor(private readonly service: AccountService) {}

  async execute(id: string): Promise<Account> {
    const entity = await this.service.findById(id);
    if (entity === null || entity === undefined) {
      throw new NotFoundException(`Account not found: ${id}`);
    }
    return entity;
  }
}
