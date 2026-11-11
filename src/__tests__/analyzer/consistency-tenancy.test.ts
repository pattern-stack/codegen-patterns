/**
 * #791 N4 — the consistency checker's system-field list names the tenant column
 * from `tenantColumnName`, not a `tenant_id` literal.
 */
import { describe, expect, it } from 'bun:test';

import { checkConsistency } from '../../analyzer/consistency-checker';
import { buildDomainGraph } from '../../analyzer/graph-builder';
import type { ParsedEntity, ParsedField } from '../../analyzer/types';

const field = (name: string): ParsedField => ({
	name,
	type: 'uuid',
	required: false,
	nullable: true,
	unique: false,
	index: false,
	constraints: {},
	ui: {},
	analytics: {},
});

const entity = (column: string, extra: Partial<ParsedEntity> = {}): ParsedEntity => ({
	name: 'deal',
	plural: 'deals',
	table: 'deals',
	expose: ['repository'],
	fields: new Map([[column, field(column)]]),
	relationships: new Map(),
	behaviors: [],
	sourcePath: 'entities/deal.yaml',
	...extra,
});

const uiIssues = (e: ParsedEntity, project = 'tenant_id') =>
	checkConsistency(buildDomainGraph([e]), project).filter((i) => i.type === 'missing_ui_metadata');

describe('consistency checker: the tenant column is a system field (#791)', () => {
	it('the default tenant_id is exempt', () => {
		expect(uiIssues(entity('tenant_id'))).toHaveLength(0);
	});

	it("an entity's own tenant_scoped column is exempt", () => {
		expect(uiIssues(entity('team_id', { tenantScoped: { column: 'team_id' } }))).toHaveLength(0);
	});

	it("the project's tenancy.column is exempt", () => {
		expect(uiIssues(entity('workspace_id', { tenantScoped: true }), 'workspace_id')).toHaveLength(0);
	});

	it('an ordinary field of the same shape is still reported', () => {
		expect(uiIssues(entity('team_id'))).toHaveLength(1);
	});
});
