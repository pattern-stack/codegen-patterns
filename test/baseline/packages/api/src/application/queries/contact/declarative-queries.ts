/**
 * Declarative Query Classes for Contact
 * Generated from queries: block in entity YAML - do not edit directly
 */

import { Inject, Injectable } from '@nestjs/common';
import { CONTACT_REPOSITORY } from '../../../constants';
import type { IContactRepository } from '../../../domain';
import type { Contact } from '../../../domain';

@Injectable()
export class FindByUserIdQuery {
	constructor(
		@Inject(CONTACT_REPOSITORY)
		private readonly repository: IContactRepository,
	) {}

	async execute(userId: string): Promise<Contact[]> {
		return this.repository.findByUserId(userId);
	}
}

@Injectable()
export class FindByEmailQuery {
	constructor(
		@Inject(CONTACT_REPOSITORY)
		private readonly repository: IContactRepository,
	) {}

	async execute(email: string): Promise<Contact | null> {
		return this.repository.findByEmail(email);
	}
}

@Injectable()
export class FindByAccountIdQuery {
	constructor(
		@Inject(CONTACT_REPOSITORY)
		private readonly repository: IContactRepository,
	) {}

	async execute(accountId: string): Promise<Contact[]> {
		return this.repository.findByAccountId(accountId);
	}
}

@Injectable()
export class FindByUserIdAndAccountIdQuery {
	constructor(
		@Inject(CONTACT_REPOSITORY)
		private readonly repository: IContactRepository,
	) {}

	async execute(userId: string, accountId: string): Promise<Contact[]> {
		return this.repository.findByUserIdAndAccountId(userId, accountId);
	}
}

@Injectable()
export class FindByOpportunityIdQuery {
	constructor(
		@Inject(CONTACT_REPOSITORY)
		private readonly repository: IContactRepository,
	) {}

	async execute(opportunityId: string): Promise<Contact[]> {
		return this.repository.findByOpportunityId(opportunityId);
	}
}

@Injectable()
export class FindEmailsByOpportunityIdQuery {
	constructor(
		@Inject(CONTACT_REPOSITORY)
		private readonly repository: IContactRepository,
	) {}

	async execute(opportunityId: string): Promise<string[]> {
		return this.repository.findEmailsByOpportunityId(opportunityId);
	}
}

export const declarativeQueryClasses = [
	FindByUserIdQuery,
	FindByEmailQuery,
	FindByAccountIdQuery,
	FindByUserIdAndAccountIdQuery,
	FindByOpportunityIdQuery,
	FindEmailsByOpportunityIdQuery,
];
