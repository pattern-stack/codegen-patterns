/**
 * validateEntityEmits unit tests (EVT-7).
 */

import { describe, it, expect } from 'bun:test';
import { validateEntityEmits } from '../../parser/validate-emits';
import type { ParsedEntity } from '../../analyzer/types';
import type { EventDefinition } from '../../schema/event-definition.schema';

function makeEntity(partial: Partial<ParsedEntity>): ParsedEntity {
	return {
		name: 'contact',
		plural: 'contacts',
		table: 'contacts',
		expose: ['repository', 'rest', 'trpc'],
		folderStructure: 'nested',
		fields: new Map(),
		relationships: new Map(),
		behaviors: [],
		sourcePath: 'entities/contact.yaml',
		...partial,
	};
}

function makeEvent(partial: Partial<EventDefinition> & { type: string }): EventDefinition {
	return {
		type: partial.type,
		direction: 'change',
		aggregate: 'contact',
		payload: {},
		retry: { attempts: 3, backoff: 'exponential' },
		version: 1,
		pool: 'events_change',
		...partial,
	};
}

describe('validateEntityEmits — valid emits', () => {
	it('returns no issues for a single valid emit', () => {
		const entities = [makeEntity({ emits: ['contact_created'] })];
		const events = [makeEvent({ type: 'contact_created' })];
		const issues = validateEntityEmits(entities, events);
		expect(issues).toEqual([]);
	});

	it('returns no issues for multiple valid emits', () => {
		const entities = [
			makeEntity({
				emits: ['contact_created', 'contact_updated', 'contact_deleted'],
			}),
		];
		const events = [
			makeEvent({ type: 'contact_created' }),
			makeEvent({ type: 'contact_updated' }),
			makeEvent({ type: 'contact_deleted' }),
		];
		const issues = validateEntityEmits(entities, events);
		expect(issues).toEqual([]);
	});

	it('returns no issues for explicit empty array (opt-out)', () => {
		const entities = [makeEntity({ emits: [] })];
		const events: EventDefinition[] = [];
		const issues = validateEntityEmits(entities, events);
		expect(issues).toEqual([]);
	});
});

describe('validateEntityEmits — missing / mismatched registry entries', () => {
	it('errors when emit has no matching event', () => {
		const entities = [makeEntity({ emits: ['contact_missing'] })];
		const events = [makeEvent({ type: 'contact_created' })];
		const issues = validateEntityEmits(entities, events);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.severity).toBe('error');
		expect(issues[0]?.type).toBe('missing_event_declaration');
		expect(issues[0]?.entity).toBe('contact');
		expect(issues[0]?.message).toContain('contact_missing');
	});

	it('errors when emit direction is not change', () => {
		const entities = [makeEntity({ emits: ['contact_sync'] })];
		const events = [
			makeEvent({
				type: 'contact_sync',
				direction: 'outbound',
				aggregate: undefined,
				destination: 'salesforce',
				pool: 'events_outbound',
			}),
		];
		const issues = validateEntityEmits(entities, events);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.severity).toBe('error');
		expect(issues[0]?.type).toBe('emit_wrong_direction');
		expect(issues[0]?.message).toContain("direction 'outbound'");
	});

	it('errors when emit aggregate does not match entity', () => {
		const entities = [makeEntity({ emits: ['deal_created'] })];
		const events = [
			makeEvent({ type: 'deal_created', aggregate: 'deal' }),
		];
		const issues = validateEntityEmits(entities, events);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.severity).toBe('error');
		expect(issues[0]?.type).toBe('emit_wrong_aggregate');
		expect(issues[0]?.message).toContain("'deal'");
		expect(issues[0]?.message).toContain("'contact'");
	});

	it('labels missing aggregate as (none)', () => {
		const entities = [makeEntity({ emits: ['floating_event'] })];
		const events = [
			makeEvent({
				type: 'floating_event',
				aggregate: undefined,
				direction: 'change',
			}),
		];
		const issues = validateEntityEmits(entities, events);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.type).toBe('emit_wrong_aggregate');
		expect(issues[0]?.message).toContain('(none)');
	});
});

describe('validateEntityEmits — duplicates', () => {
	it('warns on duplicate entries within one emits array', () => {
		const entities = [
			makeEntity({ emits: ['contact_created', 'contact_created'] }),
		];
		const events = [makeEvent({ type: 'contact_created' })];
		const issues = validateEntityEmits(entities, events);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.severity).toBe('warning');
		expect(issues[0]?.type).toBe('duplicate_emit');
	});
});

describe('validateEntityEmits — absent emits block', () => {
	it('warns once per entity without an emits block', () => {
		const entities = [
			makeEntity({ name: 'contact', emits: undefined }),
			makeEntity({ name: 'deal', emits: undefined }),
		];
		const issues = validateEntityEmits(entities, []);
		expect(issues).toHaveLength(2);
		expect(issues.every((i) => i.severity === 'warning')).toBe(true);
		expect(issues.every((i) => i.type === 'no_emits')).toBe(true);
		expect(issues[0]?.message).toContain('no emits: block');
	});

	it('does NOT warn for explicit empty array', () => {
		const entities = [makeEntity({ emits: [] })];
		const issues = validateEntityEmits(entities, []);
		expect(issues).toEqual([]);
	});
});

describe('validateEntityEmits — multi-entity mix', () => {
	it('handles a mix of valid, invalid, and absent emits independently', () => {
		const entities = [
			makeEntity({ name: 'contact', emits: ['contact_created'] }),
			makeEntity({
				name: 'deal',
				emits: ['deal_nonexistent'],
				sourcePath: 'entities/deal.yaml',
			}),
			makeEntity({
				name: 'user',
				emits: undefined,
				sourcePath: 'entities/user.yaml',
			}),
		];
		const events = [
			makeEvent({ type: 'contact_created', aggregate: 'contact' }),
		];
		const issues = validateEntityEmits(entities, events);
		expect(issues).toHaveLength(2);

		const missing = issues.find((i) => i.type === 'missing_event_declaration');
		expect(missing?.entity).toBe('deal');

		const noEmits = issues.find((i) => i.type === 'no_emits');
		expect(noEmits?.entity).toBe('user');
	});
});
