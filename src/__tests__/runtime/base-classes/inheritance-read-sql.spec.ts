/**
 * RFC-0006 §3, §6 (#875, S3) — the family reads and the child's scope, as SQL.
 *
 * Written in the shape `templates/entity/new/backend/repository.ejs.t`
 * emits for a joined-table family (a hand copy, NOT the template's text: see the RFC's S3 gates note), like `read-api-sql.spec.ts` does for the
 * READ-1 surface; the GENERATED repositories are driven against Postgres by
 * `test/scaffold/tests/inheritance-reads.test.ts`. This file pins, without
 * Docker, the SQL each read renders, through a fake `pg` client that records
 * every statement:
 *
 *   - A9: `findAllKinds` is ONE statement; `kinds` joins only those children;
 *   - A8: a child whose base declares `soft_delete` carries the base's guard as
 *     one `EXISTS` on the primary key — at the root AND at a hop into the child;
 *   - a tenant-only family (the child's own tenant column carries the scope)
 *     emits no `EXISTS` anywhere.
 */
import { describe, expect, it } from 'bun:test';
import { and, defineRelations, eq, inArray, notExists, or, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import {
	BaseRepository,
	type BehaviorConfig,
	type ListOptions,
} from '../../../../runtime/base-classes/base-repository';
import {
	asKind,
	flattenBase,
	OrphanBaseError,
} from '../../../../runtime/base-classes/inheritance';
import {
	hopScope,
	scopedRoot,
	tableScope,
} from '../../../../runtime/base-classes/scope-filters';
import { withRequester } from '../../../../runtime/base-classes/tenant-context';

// ── the schema, as the entity templates emit one ───────────────────────────
// A tenant-only family: `comms` ← `meetings`, `emails` (and `message`, base-only).
const comms = pgTable('comms', {
	id: uuid('id').primaryKey().defaultRandom(),
	tenantId: uuid('tenant_id').notNull(),
	kind: text('kind').notNull(),
	occurredAt: timestamp('occurred_at').notNull(),
});
const meetings = pgTable('meetings', {
	id: uuid('id').primaryKey(),
	kind: text('kind').notNull().default('meeting'),
	tenantId: uuid('tenant_id').notNull(),
	title: text('title').notNull(),
});
const emails = pgTable('emails', {
	id: uuid('id').primaryKey(),
	kind: text('kind').notNull().default('email'),
	tenantId: uuid('tenant_id').notNull(),
	subject: text('subject').notNull(),
});
// A family whose base declares `soft_delete`: `parts` ← `transcript_parts`.
const parts = pgTable('parts', {
	id: uuid('id').primaryKey().defaultRandom(),
	tenantId: uuid('tenant_id').notNull(),
	deletedAt: timestamp('deleted_at'),
	kind: text('kind').notNull(),
	sequence: text('sequence').notNull(),
});
const transcriptParts = pgTable('transcript_parts', {
	id: uuid('id').primaryKey(),
	kind: text('kind').notNull().default('meeting'),
	tenantId: uuid('tenant_id').notNull(),
	body: text('body').notNull(),
});
const schema = { comms, meetings, emails, parts, transcriptParts };

// ── the manifest, as `emit-manifest.ts` renders it ──────────────────────────
const tenant = { tenantScoped: true, tenantColumn: 'tenantId', enforcement: 'strict' } as const;
const COMMS_SCOPE = tableScope(comms, { ...tenant, softDelete: false, userTracking: false });
// A tenant-only family: the child's scope is its own tenant column, nothing about the base.
const MEETINGS_SCOPE = tableScope(meetings, { ...tenant, softDelete: false, userTracking: false });
const EMAILS_SCOPE = tableScope(emails, { ...tenant, softDelete: false, userTracking: false });
const PARTS_SCOPE = tableScope(parts, { ...tenant, softDelete: true, userTracking: false });
// A soft-delete base: the child gains `baseScope`.
const TRANSCRIPT_PARTS_SCOPE = tableScope(transcriptParts, {
	...tenant,
	softDelete: false,
	userTracking: false,
	baseScope: { table: parts, softDelete: true, userTracking: false },
});

const relations = defineRelations(schema, (r) => ({
	comms: {
		meeting: r.one.meetings({
			from: r.comms.id,
			to: r.meetings.id,
			optional: true,
			where: { RAW: (t) => hopScope(t, MEETINGS_SCOPE, 'comms.meeting') },
		}),
		email: r.one.emails({
			from: r.comms.id,
			to: r.emails.id,
			optional: true,
			where: { RAW: (t) => hopScope(t, EMAILS_SCOPE, 'comms.email') },
		}),
	},
	meetings: {
		communication: r.one.comms({
			from: r.meetings.id,
			to: r.comms.id,
			optional: false,
			where: { RAW: (t) => hopScope(t, COMMS_SCOPE, 'meetings.communication') },
		}),
	},
	parts: {
		transcriptPart: r.one.transcriptParts({
			from: r.parts.id,
			to: r.transcriptParts.id,
			optional: true,
			where: { RAW: (t) => hopScope(t, TRANSCRIPT_PARTS_SCOPE, 'parts.transcriptPart') },
		}),
	},
	transcriptParts: {
		part: r.one.parts({
			from: r.transcriptParts.id,
			to: r.parts.id,
			optional: false,
			where: { RAW: (t) => hopScope(t, PARTS_SCOPE, 'transcriptParts.part') },
		}),
	},
}));
type Relations = typeof relations;

// ── a fake pg client: records statements, serves canned rows ────────────────
interface Recorded {
	text: string;
	values: unknown[];
}
function fakeDb(rows: unknown[][] = []) {
	const statements: Recorded[] = [];
	const client = {
		query: async (cfg: { text: string }, values?: unknown[]) => {
			statements.push({ text: cfg.text, values: values ?? [] });
			return { rows, fields: [] };
		},
	};
	// The fake is structurally a `pg` client for every method drizzle calls.
	const db = drizzle({ client: client as never, relations });
	return { db, statements };
}

// ── the repositories, in the generated shape ────────────────────────────────
type Comm = InferSelectModel<typeof comms>;
type Meeting = InferSelectModel<typeof meetings>;
type Email = InferSelectModel<typeof emails>;
type CommKind = Comm['kind'];

const COMM_CHILD_KEY_BY_KIND = { email: 'email', meeting: 'meeting' } as const;
function commKindJoins(kinds: readonly CommKind[] | undefined): { email?: true; meeting?: true } {
	return {
		...(kinds === undefined || kinds.includes('email') ? { email: true as const } : {}),
		...(kinds === undefined || kinds.includes('meeting') ? { meeting: true as const } : {}),
	};
}
type CommOfKind =
	| (Comm & { kind: 'meeting'; meeting: Meeting })
	| (Comm & { kind: 'email'; email: Email })
	| (Comm & { kind: 'message' });

class CommRepository extends BaseRepository<Comm, typeof comms, Relations> {
	readonly table = comms;
	protected override readonly behaviors: BehaviorConfig = {
		timestamps: false,
		softDelete: false,
		userTracking: false,
		tenantScoped: true,
		tenantColumn: 'tenantId',
	};
	protected override readonly scopeEnforcement = 'strict' as const;

	constructor(db: ConstructorParameters<typeof BaseRepository<Comm, typeof comms, Relations>>[0]) {
		super(db);
		this.requireRelationalQuery('comms');
	}

	async findAllKinds(
		query?: ListOptions<typeof comms> & { kinds?: readonly CommKind[] },
	): Promise<CommOfKind[]> {
		const kinds = query?.kinds;
		const sort = query?.sort;
		const rows = await this.db.query.comms.findMany({
			where: {
				RAW: this.rootFilter((t) =>
					and(query?.where?.(t), kinds === undefined ? undefined : inArray(t.kind, [...kinds])),
				),
			},
			with: commKindJoins(kinds),
			orderBy: sort === undefined || sort.length === 0 ? undefined : (t) => this.orderByOn(t, sort) ?? [],
			limit: query?.limit,
			offset: query?.offset,
		});
		return rows.map((row) => asKind<CommOfKind>(row, 'kind', COMM_CHILD_KEY_BY_KIND));
	}

	async findOrphans(opts?: { limit?: number }): Promise<Comm[]> {
		const rows = await this.db.query.comms.findMany({
			where: {
				RAW: this.rootFilter((t) =>
					or(
						and(
							eq(t.kind, 'email'),
							notExists(this.db.select({ one: sql`1` }).from(emails).where(eq(emails.id, t.id))),
						),
						and(
							eq(t.kind, 'meeting'),
							notExists(this.db.select({ one: sql`1` }).from(meetings).where(eq(meetings.id, t.id))),
						),
					),
				),
			},
			orderBy: { id: 'asc' },
			limit: opts?.limit,
		});
		return rows as Comm[];
	}
}

type Meetings = InferSelectModel<typeof meetings>;
class MeetingRepository extends BaseRepository<Meetings, typeof meetings, Relations> {
	readonly table = meetings;
	// A tenant-only family: the child declares its tenant column, and no base scope.
	protected override readonly behaviors: BehaviorConfig = {
		timestamps: false,
		softDelete: false,
		userTracking: false,
		tenantScoped: true,
		tenantColumn: 'tenantId',
	};
	protected override readonly scopeEnforcement = 'strict' as const;
	constructor(db: ConstructorParameters<typeof BaseRepository<Meetings, typeof meetings, Relations>>[0]) {
		super(db);
		this.requireRelationalQuery('meetings');
	}
	async findWithBase(id: string) {
		const row = await this.db.query.meetings.findFirst({
			where: { RAW: this.rootFilter((t) => eq(t.id, id)) },
			with: { communication: true as const },
		});
		return row ? flattenBase(row as never, 'communication') : null;
	}
}

type Part = InferSelectModel<typeof parts>;
type TranscriptPart = InferSelectModel<typeof transcriptParts>;
class PartRepository extends BaseRepository<Part, typeof parts, Relations> {
	readonly table = parts;
	protected override readonly behaviors: BehaviorConfig = {
		timestamps: false,
		softDelete: true,
		userTracking: false,
		tenantScoped: true,
		tenantColumn: 'tenantId',
	};
	protected override readonly scopeEnforcement = 'strict' as const;
	constructor(db: ConstructorParameters<typeof BaseRepository<Part, typeof parts, Relations>>[0]) {
		super(db);
		this.requireRelationalQuery('parts');
	}
	async findWithChild(id: string) {
		return this.db.query.parts.findFirst({
			where: { RAW: this.rootFilter((t) => eq(t.id, id)) },
			with: { transcriptPart: true as const },
		});
	}
}
class TranscriptPartRepository extends BaseRepository<TranscriptPart, typeof transcriptParts, Relations> {
	readonly table = transcriptParts;
	// Joined-table child: its tenant column is a copy of the base's; its row is in scope only while its base row is.
	protected override readonly behaviors: BehaviorConfig = {
		timestamps: false,
		softDelete: false,
		userTracking: false,
		tenantScoped: true,
		tenantColumn: 'tenantId',
		baseScope: { table: parts, softDelete: true, userTracking: false },
	};
	protected override readonly scopeEnforcement = 'strict' as const;
	constructor(
		db: ConstructorParameters<typeof BaseRepository<TranscriptPart, typeof transcriptParts, Relations>>[0],
	) {
		super(db);
		this.requireRelationalQuery('transcriptParts');
	}
	async findOne(id: string) {
		return this.db.query.transcriptParts.findFirst({
			where: { RAW: this.rootFilter((t) => eq(t.id, id)) },
		});
	}
	/** The by-id write path: no `softDelete` flag, so it still matches a soft-deleted base. */
	scopeForWrite() {
		return this.scopeAnd(eq(this.col('id'), 'x'));
	}
	/** A hand-written call that names the flag. */
	scopeWithFlag(softDelete: boolean) {
		return this.scopeAnd(eq(this.col('id'), 'x'), { softDelete });
	}
}

const T1 = '11111111-1111-4111-8111-111111111111';
const asT1 = <T>(fn: () => PromiseLike<T> | T) =>
	withRequester({ userId: 'u1', organizationId: null, tenantId: T1 }, fn);

/**
 * The base's guard on a child's alias: `exists (select 1 from "parts" where "parts"."id" = "<alias>"."id" and
 * "parts"."deleted_at" is null)`, whatever parentheses drizzle wraps its conjuncts in.
 */
const existsOnParts = (alias: string) =>
	new RegExp(
		`exists \\(select 1 from "parts" where \\(*"parts"\\."id" = "${alias}"\\."id"\\)* and \\(*"parts"\\."deleted_at" is null\\)*\\)`,
	);

describe('A9 — findAllKinds is one statement', () => {
	it('joins every child kind, once, in a single statement', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new CommRepository(db).findAllKinds());
		expect(statements).toHaveLength(1);
		const text = statements[0]!.text;
		expect(text).toContain('from "comms" as "d0"');
		expect(text).toContain('from "meetings" as');
		expect(text).toContain('from "emails" as');
		// Scoped at the root and at each hop — the same tenant guard as every read.
		expect(text).toContain('"d0"."tenant_id" = $');
		expect(statements[0]!.values.filter((v) => v === T1).length).toBeGreaterThanOrEqual(3);
	});

	it('`kinds` joins only those children, and filters the scan', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new CommRepository(db).findAllKinds({ kinds: ['meeting'] }));
		expect(statements).toHaveLength(1);
		const text = statements[0]!.text;
		expect(text).toContain('from "meetings" as');
		expect(text).not.toContain('"emails"');
		expect(text).toMatch(/"d0"\."kind" in \(\$\d+\)/);
	});

	it('a caller `where`, `sort` and `limit` render on the alias too', async () => {
		const { db, statements } = fakeDb();
		await asT1(() =>
			new CommRepository(db).findAllKinds({
				where: (t) => eq(t.kind, 'meeting'),
				sort: [{ column: 'occurredAt', direction: 'desc' }],
				limit: 5,
			}),
		);
		const text = statements[0]!.text;
		expect(text).toContain('order by "d0"."occurred_at" desc');
		expect(text).toMatch(/limit \$\d+/);
	});

	it('findOrphans is one statement: a not-exists per child kind, on the base root scope', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new CommRepository(db).findOrphans({ limit: 10 }));
		expect(statements).toHaveLength(1);
		const text = statements[0]!.text;
		expect(text.match(/not exists \(select 1 from "(meetings|emails)"/g)).toHaveLength(2);
		expect(text).toContain('"d0"."tenant_id" = $');
	});
});

describe('A8 — a child is in scope only while its base row is', () => {
	it('a child root read carries the base`s soft-delete as one EXISTS on the primary key', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new TranscriptPartRepository(db).findOne('p1'));
		expect(statements).toHaveLength(1);
		expect(statements[0]!.text).toMatch(existsOnParts('d0'));
		// The child's own tenant axis is still its own column.
		expect(statements[0]!.text).toContain('"d0"."tenant_id" = $');
	});

	it('a HOP into the child carries it too (the root is the base)', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new PartRepository(db).findWithChild('p1'));
		expect(statements).toHaveLength(1);
		const text = statements[0]!.text;
		// Root: the base's own soft-delete. Hop: the child's tenant AND the base's EXISTS.
		expect(text).toContain('"d0"."deleted_at" is null');
		expect(text).toMatch(existsOnParts('d1'));
	});

	it('a by-id WRITE path still matches a soft-deleted base (no flag passed)', async () => {
		const { db } = fakeDb();
		const repo = new TranscriptPartRepository(db);
		const rendered = await asT1(() => repo.scopeForWrite());
		expect(rendered).toBeDefined();
		const text = new PgDialect().sqlToQuery(rendered!).sql;
		expect(text).not.toContain('deleted_at');
		expect(text).not.toContain('exists');
	});

	it('`softDelete` has one meaning: true applies the base guard, false still reaches a deleted base', async () => {
		const { db } = fakeDb();
		const repo = new TranscriptPartRepository(db);
		const sqlOf = (s: any) => new PgDialect().sqlToQuery(s).sql;
		await asT1(async () => {
			expect(sqlOf(repo.scopeWithFlag(true))).toContain('"parts"."deleted_at" is null');
			// A hand-written { softDelete: false } that wants deleted rows gets them on the child too.
			expect(sqlOf(repo.scopeWithFlag(false))).not.toContain('deleted_at');
		});
	});

	it('the manifest path: the scope renders the same EXISTS for a hand-written root', async () => {
		const { db, statements } = fakeDb();
		await asT1(() =>
			db.query.transcriptParts.findMany({
				where: { AND: [scopedRoot(TRANSCRIPT_PARTS_SCOPE, 'Loader')] },
			}),
		);
		expect(statements[0]!.text).toMatch(existsOnParts('d0'));
	});

	it('a tenant-only family emits NO exists — the child`s own tenant column carries the scope', async () => {
		const { db, statements } = fakeDb();
		const repo = new MeetingRepository(db);
		await asT1(() => repo.findWithBase('m1'));
		await asT1(() => new CommRepository(db).findAllKinds());
		for (const s of statements) expect(s.text).not.toContain('exists (');
		expect(statements[0]!.text).toContain('"d0"."tenant_id" = $');
	});

	it('the other tenant`s child cannot be read: the child`s own tenant column is a parameter', async () => {
		const { db, statements } = fakeDb();
		await asT1(() => new MeetingRepository(db).findWithBase('m1'));
		expect(statements[0]!.values).toContain(T1);
	});
});

describe('flattenBase / asKind — pure', () => {
	it('flattenBase hoists the base relation`s columns to the root and drops the key', () => {
		const flat = flattenBase(
			{ id: 'm', title: 'T', communication: { id: 'm', source: 'src', occurredAt: 1 } },
			'communication',
		);
		expect(flat).toEqual({ id: 'm', title: 'T', source: 'src', occurredAt: 1 });
		expect('communication' in flat).toBe(false);
	});

	it('asKind nests the child under its key and drops the other kinds` keys', () => {
		const row = { id: 'x', kind: 'meeting', meeting: { id: 'x', title: 'T' }, email: null };
		const out = asKind<{ kind: string; meeting: { title: string } }>(row, 'kind', COMM_CHILD_KEY_BY_KIND);
		expect(out.meeting.title).toBe('T');
		expect('email' in out).toBe(false);
	});

	it('asKind passes a base-only kind through bare', () => {
		const row = { id: 'x', kind: 'message', meeting: null, email: null };
		const out = asKind<{ kind: string }>(row, 'kind', COMM_CHILD_KEY_BY_KIND);
		expect(out).toEqual({ id: 'x', kind: 'message' });
	});

	it('asKind throws OrphanBaseError for a kind with a child table and no child row', () => {
		const row = { id: 'x', kind: 'email', meeting: null, email: null };
		expect(() => asKind(row, 'kind', COMM_CHILD_KEY_BY_KIND)).toThrow(OrphanBaseError);
		expect(() => asKind(row, 'kind', COMM_CHILD_KEY_BY_KIND)).toThrow(/x.*email.*email/);
	});
});
