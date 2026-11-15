/**
 * RFC-0006 §4, §5, §2.4 (#875, S4) — the pure parts of the pair writes, without a database.
 *
 * The generated repositories are driven against Postgres by
 * `test/scaffold/tests/inheritance-writes.test.ts`; this file pins what has no
 * need of one: the owner split, the transaction rule, the upsert's `SET`, the
 * derived-column subquery's SQL, and the lifecycle events a child service
 * emits under both names.
 */
import { describe, expect, it, mock } from 'bun:test';
import { PgDialect, pgEnum, pgTable, uuid } from 'drizzle-orm/pg-core';

import { BaseService, type IBaseRepository } from '../../../../runtime/base-classes/base-service';
import {
	assertBaseOnlyKind,
	fillDerivedColumns,
	inTransaction,
	KindRequiresChildError,
	MatchColumnImmutableError,
	splitByOwner,
	upsertSet,
	type DerivedColumn,
} from '../../../../runtime/base-classes/inheritance';

describe('splitByOwner', () => {
	const baseKeys = new Set(['id', 'kind', 'tenantId', 'occurredAt']);

	it('sends the base\'s columns to the base and the rest to the child', () => {
		const { base, own } = splitByOwner(
			{ occurredAt: 1, title: 'standup', tenantId: 't', startsAt: 2 },
			baseKeys,
		);
		expect(base).toEqual({ occurredAt: 1, tenantId: 't' });
		expect(own).toEqual({ title: 'standup', startsAt: 2 });
	});

	it('drops an undefined value: an absent key, not an instruction to clear', () => {
		const { base, own } = splitByOwner({ occurredAt: undefined, link: undefined, endsAt: null }, baseKeys);
		expect(base).toEqual({});
		expect(own).toEqual({ endsAt: null });
	});
});

describe('inTransaction', () => {
	it('joins the caller\'s transaction and opens none', async () => {
		const transaction = mock(async () => undefined);
		const tx = { marker: 'caller' };
		const result = await inTransaction({ transaction } as never, tx as never, async (t) => (t as never as typeof tx).marker);
		expect(result).toBe('caller');
		expect(transaction).not.toHaveBeenCalled();
	});

	it('opens one when none is passed, and hands the callback its handle', async () => {
		const handle = { marker: 'opened' };
		const transaction = mock(async (fn: (t: unknown) => Promise<unknown>) => fn(handle));
		const result = await inTransaction({ transaction } as never, undefined, async (t) => (t as never as typeof handle).marker);
		expect(result).toBe('opened');
		expect(transaction).toHaveBeenCalledTimes(1);
	});

	it('lets a failure out of the callback propagate (so the driver rolls back)', async () => {
		const transaction = mock(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
		await expect(
			inTransaction({ transaction } as never, undefined, async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
	});
});

describe('upsertSet', () => {
	it('carries the columns the input carries, minus the ones an upsert never rewrites', () => {
		const never = new Set(['id', 'kind', 'tenantId', 'source', 'externalId', 'createdAt']);
		const set = upsertSet(
			{ id: 'x', kind: 'meeting', tenantId: 't', source: 's', externalId: 'e', createdAt: 1, title: 'a', link: null, endsAt: undefined },
			never,
		);
		// `link: null` clears; `endsAt: undefined` is absent and left alone.
		expect(set).toEqual({ title: 'a', link: null });
	});
});

describe('assertBaseOnlyKind', () => {
	const paths = { meeting: 'MeetingService.create', email: 'EmailService.create' };

	it('refuses a kind that has a child table, naming its create path', () => {
		try {
			assertBaseOnlyKind('communication', 'meeting', paths);
			throw new Error('did not throw');
		} catch (err) {
			expect(err).toBeInstanceOf(KindRequiresChildError);
			expect((err as KindRequiresChildError).createPath).toBe('MeetingService.create');
			expect((err as Error).message).toContain('MeetingService.create');
		}
	});

	it('passes a base-only kind, and an absent one', () => {
		expect(() => assertBaseOnlyKind('communication', 'message', paths)).not.toThrow();
		expect(() => assertBaseOnlyKind('communication', undefined, paths)).not.toThrow();
		// `constructor` is not a kind.
		expect(() => assertBaseOnlyKind('communication', 'constructor', paths)).not.toThrow();
	});
});

describe('fillDerivedColumns — the match: subquery', () => {
	const kindEnum = pgEnum('communication_kind', ['meeting', 'email', 'message']);
	const communications = pgTable('communications', { id: uuid('id').primaryKey(), kind: kindEnum('kind').notNull() });
	const roles = pgTable('participant_roles', { id: uuid('id').primaryKey(), kind: kindEnum('kind').notNull() });
	const participants = pgTable('participants', {
		id: uuid('id').primaryKey(),
		communicationId: uuid('communication_id').notNull(),
		roleId: uuid('role_id').notNull(),
		communicationKind: kindEnum('communication_kind').notNull(),
	});
	const dialect = new PgDialect();
	const render = (value: unknown) => dialect.sqlToQuery(value as never);

	const fromCommunication = {
		fkKey: 'communicationId',
		fkColumn: participants.communicationId,
		parentTable: communications,
		parentId: communications.id,
		parentValue: communications.kind,
	};
	const fromRole = {
		fkKey: 'roleId',
		fkColumn: participants.roleId,
		parentTable: roles,
		parentId: roles.id,
		parentValue: roles.kind,
	};
	const derived: DerivedColumn[] = [{ key: 'communicationKind', sources: [fromCommunication, fromRole] }];

	it('create: a scalar subquery on the parent\'s primary key, in the same statement; the caller\'s value is overwritten', () => {
		const out = fillDerivedColumns(
			'participant',
			{ communicationId: 'c1', roleId: 'r1', communicationKind: 'email' },
			'create',
			[{ key: 'communicationKind', sources: [fromCommunication] }],
		);
		const q = render(out.communicationKind);
		expect(q.sql).toBe(
			'(select "communications"."kind" from "communications" where "communications"."id" = $1)',
		);
		expect(q.params).toEqual(['c1']);
		// The other columns are untouched.
		expect(out.communicationId).toBe('c1');
	});

	it('several relationships matching one column are tried in declaration order', () => {
		const out = fillDerivedColumns('participant', { communicationId: 'c1', roleId: 'r1' }, 'create', derived);
		const q = render(out.communicationKind);
		expect(q.sql).toBe(
			'coalesce((select "communications"."kind" from "communications" where "communications"."id" = $1), ' +
				'(select "participant_roles"."kind" from "participant_roles" where "participant_roles"."id" = $2))',
		);
		expect(q.params).toEqual(['c1', 'r1']);
	});

	it('a missing foreign key derives from NULL, which the column\'s NOT NULL refuses', () => {
		const out = fillDerivedColumns('participant', { roleId: 'r1' }, 'create', derived);
		expect(render(out.communicationKind).params).toEqual([null, 'r1']);
	});

	it('update: leaves the column alone while no foreign key it follows is in the payload', () => {
		const out = fillDerivedColumns('participant', { partyId: null }, 'update', derived);
		expect('communicationKind' in out).toBe(false);
	});

	it('update: re-derives when a foreign key changes, reading the other from the row', () => {
		const out = fillDerivedColumns('participant', { communicationId: 'c2' }, 'update', derived);
		const q = render(out.communicationKind);
		expect(q.sql).toBe(
			'coalesce((select "communications"."kind" from "communications" where "communications"."id" = $1), ' +
				'(select "participant_roles"."kind" from "participant_roles" where "participant_roles"."id" = "participants"."role_id"))',
		);
		expect(q.params).toEqual(['c2']);
	});

	it('update: the column named without a foreign key changing is refused (M4)', () => {
		expect(() => fillDerivedColumns('participant', { communicationKind: 'email' }, 'update', derived)).toThrow(
			MatchColumnImmutableError,
		);
	});

	it('update: the column named with the foreign key changing is overwritten, not refused', () => {
		const out = fillDerivedColumns('participant', { communicationId: 'c2', communicationKind: 'email' }, 'update', derived);
		expect(typeof out.communicationKind).toBe('object');
	});
});

describe('BaseService — a child announces under both names (A11)', () => {
	interface Meeting {
		id: string;
		kind: 'meeting';
		occurredAt: number;
		title: string;
	}

	function recordingBus() {
		const published: Array<{ type: string; aggregateId: string; payload: { snapshot?: Record<string, unknown>; fieldName?: string } }> = [];
		return {
			published,
			publish: async (event: never) => void published.push(event),
			publishMany: async (events: never[]) => void published.push(...events),
		};
	}

	class ChildService extends BaseService<IBaseRepository<Meeting>, Meeting> {
		protected override entityName = 'meeting';
		protected override baseEntityName = 'communication';
		protected override baseSliceKeys: ReadonlySet<string> = new Set(['id', 'kind', 'occurredAt']);
		// The child reads the FLAT row before an update; a table-only read would make every base field look changed.
		protected override readBeforeUpdate(id: string): Promise<Meeting | null> {
			return Promise.resolve(this.flatBefore?.(id) ?? null);
		}
		flatBefore?: (id: string) => Meeting | null;
		upserted(row: Meeting, created: boolean) {
			this.emitUpserted(row, created);
		}
	}

	const flat: Meeting = { id: 'm1', kind: 'meeting', occurredAt: 1, title: 'standup' };
	const repo = (over: Partial<IBaseRepository<Meeting>> = {}): IBaseRepository<Meeting> => ({
		findById: mock(async () => null),
		findByIds: mock(async () => []),
		list: mock(async () => []),
		count: mock(async () => 0),
		exists: mock(async () => false),
		create: mock(async () => flat),
		update: mock(async () => ({ ...flat, title: 'retro' })),
		delete: mock(async () => undefined),
		...over,
	});
	const make = () => {
		const bus = recordingBus();
		const service = new ChildService(repo());
		(service as unknown as { eventBus: unknown }).eventBus = bus;
		return { bus, service };
	};
	const types = (bus: ReturnType<typeof recordingBus>) => bus.published.map((e) => e.type).sort();

	it('create: the flat snapshot under the child, the base\'s slice under the base', async () => {
		const { bus, service } = make();
		await service.create({ title: 'standup' });
		expect(types(bus)).toEqual(['communication.created', 'meeting.created']);
		expect(bus.published.find((e) => e.type === 'meeting.created')!.payload.snapshot).toEqual({
			kind: 'meeting',
			occurredAt: 1,
			title: 'standup',
		});
		expect(bus.published.find((e) => e.type === 'communication.created')!.payload.snapshot).toEqual({
			kind: 'meeting',
			occurredAt: 1,
		});
	});

	it('update: diffs against the FLAT row read before the write, so unchanged base fields are not announced', async () => {
		const { bus, service } = make();
		service.flatBefore = () => flat;
		await service.update('m1', { title: 'retro' });
		expect(types(bus)).toEqual(['communication.updated', 'meeting.field_changed', 'meeting.updated']);
		expect(bus.published.find((e) => e.type === 'meeting.field_changed')!.payload.fieldName).toBe('title');
	});

	it('delete: both names, no snapshot', async () => {
		const { bus, service } = make();
		await service.delete('m1');
		expect(types(bus)).toEqual(['communication.deleted', 'meeting.deleted']);
	});

	it('upsert: created / updated from the flag under both names, and no per-field events', () => {
		const { bus, service } = make();
		service.upserted(flat, true);
		service.upserted(flat, false);
		expect(types(bus)).toEqual([
			'communication.created',
			'communication.updated',
			'meeting.created',
			'meeting.updated',
		]);
	});

	it('a service with no base announces under its own name only', async () => {
		class PlainService extends BaseService<IBaseRepository<Meeting>, Meeting> {
			protected override entityName = 'meeting';
		}
		const bus = recordingBus();
		const service = new PlainService(repo());
		(service as unknown as { eventBus: unknown }).eventBus = bus;
		await service.create({});
		await service.delete('m1');
		expect(types(bus)).toEqual(['meeting.created', 'meeting.deleted']);
	});
});
