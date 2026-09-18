/**
 * `WithCommunication` / `WithActor` (CAP-3) — statement shape and error paths.
 *
 * The SQL is rendered with `toSQL()` on a real Drizzle client whose pool never
 * connects; round-trips against Postgres (and the scope proof) live in the
 * scaffold integration suite (`test/scaffold/tests/communication-actor.test.ts`).
 */
import { describe, expect, it } from 'bun:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { BaseRepository, type BehaviorConfig } from '../../../../runtime/base-classes/base-repository';
import { WithActor } from '../../../../runtime/base-classes/with-actor';
import { WithCommunication } from '../../../../runtime/base-classes/with-communication';
import type { DrizzleClient } from '../../../../runtime/types/drizzle';

const contacts = pgTable('contacts', { id: uuid('id').primaryKey(), accountId: uuid('account_id') });
const accounts = pgTable('accounts', { id: uuid('id').primaryKey() });
const meetings = pgTable('meetings', {
	id: uuid('id').primaryKey(),
	userId: text('user_id'),
	hostContactId: uuid('host_contact_id'),
});
const meetingContacts = pgTable('meeting_contacts', {
	meetingId: uuid('meeting_id').notNull(),
	contactId: uuid('contact_id').notNull(),
});

type Meeting = typeof meetings.$inferSelect;

// A pool that is never queried — `toSQL()` renders without connecting.
const db: DrizzleClient = drizzle({ client: new Pool({ connectionString: 'postgres://unused' }) });

class MeetingRepository extends WithCommunication(BaseRepository<Meeting, typeof meetings>) {
	readonly table = meetings;
	protected override readonly behaviors: BehaviorConfig = {
		timestamps: false,
		softDelete: false,
		userTracking: false,
	};
	override readonly communicationConfig = {
		roles: {
			host: { cardinality: 'one', target: 'contact', column: 'hostContactId' },
			attendees: {
				cardinality: 'many',
				target: 'contact',
				via: { table: meetingContacts, self: 'meetingId', target: 'contactId' },
			},
		},
	} as const;
	constructor() {
		super(db);
	}
}

class GroupAccountRepository extends WithActor(BaseRepository<typeof accounts.$inferSelect, typeof accounts>) {
	readonly table = accounts;
	override readonly actorConfig = {
		kind: 'group',
		members: { table: contacts, foreignKey: 'accountId' },
	} as const;
	constructor() {
		super(db);
	}
}

class IndividualContactRepository extends WithActor(BaseRepository<typeof contacts.$inferSelect, typeof contacts>) {
	readonly table = contacts;
	override readonly actorConfig = { kind: 'individual' } as const;
	constructor() {
		super(db);
	}
}

const whereSql = (table: typeof accounts | typeof contacts, predicate: ReturnType<GroupAccountRepository['memberPredicate']>) =>
	db.select().from(table).where(predicate).toSQL();

describe('WithCommunication', () => {
	it('findByRole on an undeclared role rejects, naming the declared roles', async () => {
		// @ts-expect-error — an undeclared role is a compile error; this pins the runtime guard
		await expect(new MeetingRepository().findByRole('organizer', 'c1')).rejects.toThrow(
			"MeetingRepository: no role 'organizer'. Declared roles: host, attendees.",
		);
	});

	it('a repository whose config was never generated says so', async () => {
		class Bare extends WithCommunication(BaseRepository<Meeting, typeof meetings>) {
			readonly table = meetings;
			constructor() {
				super(db);
			}
		}
		await expect(new Bare().participants('m1')).rejects.toThrow(/has no roles/);
	});
});

describe('WithActor.memberPredicate', () => {
	it('individual → the identity predicate over its own table', () => {
		const repo = new IndividualContactRepository();
		const q = whereSql(contacts, repo.memberPredicate('c1'));
		expect(q.sql).toBe('select "id", "account_id" from "contacts" where "contacts"."id" = $1');
		expect(q.params).toEqual(['c1']);
	});

	it('group → EXISTS over the member table, correlated to this row — one statement', () => {
		const repo = new GroupAccountRepository();
		const q = whereSql(accounts, repo.memberPredicate('c1'));
		expect(q.sql).toBe(
			'select "id" from "accounts" where exists (select 1 from "contacts" where (("contacts"."account_id" = "accounts"."id") and ("contacts"."id" = $1)))',
		);
		expect(q.params).toEqual(['c1']);
	});

	it('an Actor without config says what to declare', () => {
		class Bare extends WithActor(BaseRepository<typeof accounts.$inferSelect, typeof accounts>) {
			readonly table = accounts;
			constructor() {
				super(db);
			}
		}
		expect(() => new Bare().memberPredicate('x')).toThrow(/config: \{ Actor: \{ kind: individual \| group \} \}/);
	});
});
