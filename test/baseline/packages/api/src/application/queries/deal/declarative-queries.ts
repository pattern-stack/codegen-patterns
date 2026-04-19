/**
 * Declarative Query Classes for Deal
 * Generated from queries: block in entity YAML - do not edit directly
 */

import { Inject, Injectable } from '@nestjs/common';
import { DEAL_REPOSITORY } from '../../../constants';
import type { IDealRepository } from '../../../domain';
import type { Deal } from '../../../domain';

@Injectable()
export class FindByOwnerIdQuery {
	constructor(
		@Inject(DEAL_REPOSITORY)
		private readonly repository: IDealRepository,
	) {}

	async execute(ownerId: string): Promise<Deal[]> {
		return this.repository.findByOwnerId(ownerId);
	}
}

@Injectable()
export class FindByAccountIdQuery {
	constructor(
		@Inject(DEAL_REPOSITORY)
		private readonly repository: IDealRepository,
	) {}

	async execute(accountId: string): Promise<Deal[]> {
		return this.repository.findByAccountId(accountId);
	}
}

@Injectable()
export class FindByStageQuery {
	constructor(
		@Inject(DEAL_REPOSITORY)
		private readonly repository: IDealRepository,
	) {}

	async execute(stage: 'prospecting' | 'qualification' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost'): Promise<Deal[]> {
		return this.repository.findByStage(stage);
	}
}

@Injectable()
export class FindByOwnerIdAndStageQuery {
	constructor(
		@Inject(DEAL_REPOSITORY)
		private readonly repository: IDealRepository,
	) {}

	async execute(ownerId: string, stage: 'prospecting' | 'qualification' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost'): Promise<Deal[]> {
		return this.repository.findByOwnerIdAndStage(ownerId, stage);
	}
}

export const declarativeQueryClasses = [
	FindByOwnerIdQuery,
	FindByAccountIdQuery,
	FindByStageQuery,
	FindByOwnerIdAndStageQuery,
];
