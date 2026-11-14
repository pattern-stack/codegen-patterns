/**
 * The render matrix — the backend shapes the checked-in baseline does not exercise (PLAN F2), each one a small
 * closed definition set. Defined once: the API-surface parity gate renders them (Subject B), the golden pins
 * their derived surfaces, the raw ≡ parsed test parses them, and Phase B's byte goldens (B1) reuse them.
 *
 * Every set is closed — each entity a definition names is in `entities` — and every definition passes the
 * entity schema (the raw ≡ parsed test parses each one). Names are this repo's own fixture vocabulary.
 */

import type { DefinitionSet } from './_inputs';
import type { EntityDefinitionInput, JunctionInput } from '../../derived/api/entity';

export interface MatrixCase extends DefinitionSet {
	/** Stable id: the golden file is `test/api-surface-golden/snapshot/<id>.json`. */
	id: string;
	/** The shape this case exists to cover. */
	covers: string;
	/** The entities whose generated output the parity gate renders and compares. */
	subjects: string[];
}

// The definitions are written as raw YAML would parse — plain objects — and typed only at the edge.
const def = (d: Record<string, unknown>): EntityDefinitionInput => d as unknown as EntityDefinitionInput;
const junction = (j: Record<string, unknown>): JunctionInput => j as unknown as JunctionInput;

const contact = def({
	entity: { name: 'contact', plural: 'contacts' },
	fields: { email: { type: 'string', required: true } },
});

const account = def({
	entity: { name: 'account', plural: 'accounts' },
	fields: { name: { type: 'string', required: true } },
});

const user = def({
	entity: { name: 'user', plural: 'users' },
	fields: { email: { type: 'string', required: true } },
});

// ── EAV (ADR-13) ───────────────────────────────────────────────────────────
const fieldDefinition = def({
	entity: { name: 'field_definition', plural: 'field_definitions' },
	fields: {
		entity_type: { type: 'string', required: true },
		key: { type: 'string', required: true },
	},
	behaviors: ['timestamps'],
});

const fieldValue = def({
	entity: { name: 'field_value', plural: 'field_values', pattern: 'Metadata' },
	fields: {
		entity_type: { type: 'string', required: true },
		entity_id: { type: 'uuid', required: true },
		field_definition_id: { type: 'uuid', required: true },
		user_id: { type: 'uuid', required: true },
		value: { type: 'json', required: true },
	},
	behaviors: ['timestamps'],
	eav_value_table: true,
	eav_definition_table: 'field_definition',
});

const lead = def({
	entity: { name: 'lead', plural: 'leads', pattern: 'Integrated' },
	fields: { name: { type: 'string', required: true } },
	behaviors: ['timestamps'],
	eav: true,
});

const EAV_SET = { entities: [lead, fieldValue, fieldDefinition], junctions: [] };

// ── Capabilities (ADR-041) and roles (CAP-2) ───────────────────────────────
const meeting = def({
	entity: { name: 'meeting', plural: 'meetings', patterns: ['Activity', 'Communication'] },
	fields: { title: { type: 'string', required: true } },
	behaviors: ['timestamps'],
	roles: { host: { target: 'contact', cardinality: 'one' } },
});

const team = def({
	entity: {
		name: 'team',
		plural: 'teams',
		patterns: ['Activity', 'Actor', 'Communication'],
		config: { Actor: { kind: 'individual' } },
	},
	fields: { name: { type: 'string', required: true } },
	behaviors: ['timestamps'],
	roles: { lead: { target: 'contact', cardinality: 'one' } },
});

const call = def({
	entity: { name: 'call', plural: 'calls', patterns: ['Activity', 'Communication'] },
	fields: { subject: { type: 'string', required: true } },
	behaviors: ['timestamps'],
	relationships: { account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
	roles: {
		caller: { target: 'contact', cardinality: 'one', column: 'caller_id', nullable: true },
		regarding: { target: 'account', cardinality: 'one' },
	},
});

// ── HTTP: off, includes, read-only ─────────────────────────────────────────
const auditEntry = def({
	entity: { name: 'audit_entry', plural: 'audit_entries' },
	fields: { message: { type: 'string', required: true } },
	api: false,
});

const syncCursor = def({
	entity: { name: 'sync_cursor', plural: 'sync_cursors' },
	fields: { position: { type: 'string', required: true } },
	relationships: { account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' } },
	api: { enabled: false },
});

const project = def({
	entity: { name: 'project', plural: 'projects' },
	fields: { name: { type: 'string', required: true } },
	relationships: {
		account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
		tasks: { type: 'has_many', target: 'task', foreign_key: 'project_id' },
	},
	api: {
		includes: {
			list: { max_depth: 1, paths: ['account'] },
			find_by_id: { max_depth: 1, paths: ['account', 'tasks'] },
		},
	},
});

const task = def({
	entity: { name: 'task', plural: 'tasks' },
	fields: { title: { type: 'string', required: true } },
	relationships: { project: { type: 'belongs_to', target: 'project', foreign_key: 'project_id' } },
	generate: { writes: false },
	queries: [{ by: ['title'] }, { name: 'search', filters: ['project_id'], search: 'title' }],
});

// ── Self-FK ────────────────────────────────────────────────────────────────
const category = def({
	entity: { name: 'category', plural: 'categories' },
	fields: { name: { type: 'string', required: true } },
	relationships: {
		parent: { type: 'belongs_to', target: 'category', foreign_key: 'parent_category_id' },
		children: { type: 'has_many', target: 'category', foreign_key: 'parent_category_id' },
	},
});

// ── The queries: × belongs_to precedence collision (PLAN §3.4) ──────────────
// `queries[0]` is a plain ordered finder on the FK column: the FK finder wins and the order is lost.
// `queries[1]` is unique on the other FK column: the finder wins and the FK finder is not emitted.
const ticket = def({
	entity: { name: 'ticket', plural: 'tickets' },
	fields: { title: { type: 'string', required: true } },
	behaviors: ['timestamps'],
	relationships: {
		account: { type: 'belongs_to', target: 'account', foreign_key: 'account_id' },
		assignee: { type: 'belongs_to', target: 'user', foreign_key: 'assignee_id' },
	},
	queries: [
		{ by: ['account_id'], order: 'created_at desc' },
		{ by: ['assignee_id'], unique: true },
		{ by: ['title'], order: 'title asc' },
		{ by: ['account_id'], select: ['title'], via: 'account_ticket_link' },
	],
});

// ── Junction fan-out (JUNC-0) ──────────────────────────────────────────────
const member = def({
	entity: { name: 'member', plural: 'members' },
	fields: { name: { type: 'string', required: true } },
});

const skill = def({
	entity: { name: 'skill', plural: 'skills' },
	fields: { label: { type: 'string', required: true } },
});

const workspace = def({
	entity: { name: 'workspace', plural: 'workspaces' },
	fields: { name: { type: 'string', required: true } },
});

export const RENDER_MATRIX: readonly MatrixCase[] = [
	{
		id: 'matrix-eav',
		covers: '`eav: true` — paired reads, with-fields routes and use cases',
		subjects: ['lead'],
		...EAV_SET,
	},
	{
		id: 'matrix-eav-value-table',
		covers: '`eav_value_table: true` — upsertCurrentValues and the compound write',
		subjects: ['field_value'],
		...EAV_SET,
	},
	{
		id: 'matrix-one-capability',
		covers: 'one capability (Communication): inline mixin, two service forwarders, role-derived FK',
		subjects: ['meeting'],
		entities: [meeting, contact],
		junctions: [],
	},
	{
		id: 'matrix-two-capabilities',
		covers: 'two capabilities (Actor + Communication): the composed base',
		subjects: ['team'],
		entities: [team, contact],
		junctions: [],
	},
	{
		id: 'matrix-role',
		covers: 'two `cardinality: one` roles beside a declared belongs_to onto the same target',
		subjects: ['call'],
		entities: [call, contact, account],
		junctions: [],
	},
	{
		id: 'matrix-api-false',
		covers: '`api: false` and `api: { enabled: false }` — no controller, everything else kept',
		subjects: ['audit_entry', 'sync_cursor'],
		entities: [auditEntry, syncCursor, account],
		junctions: [],
	},
	{
		id: 'matrix-api-includes',
		covers: '`api.includes` on both read routes; a has_many onto a wired target',
		subjects: ['project'],
		entities: [project, task, account],
		junctions: [],
	},
	{
		id: 'matrix-writes-false',
		covers: '`generate.writes: false` — no write use cases or routes; a search beside it',
		subjects: ['task'],
		entities: [project, task, account],
		junctions: [],
	},
	{
		id: 'matrix-self-fk',
		covers: 'a self-referential belongs_to and has_many',
		subjects: ['category'],
		entities: [category],
		junctions: [],
	},
	{
		id: 'matrix-precedence',
		covers: 'the queries: × belongs_to collision, both directions, with an ordered query',
		subjects: ['ticket'],
		entities: [ticket, account, user],
		junctions: [],
	},
	{
		id: 'matrix-junction-fan-out',
		covers: 'junction fan-out on both parents; a hidden side; a junction without is_primary',
		subjects: ['member', 'skill', 'workspace'],
		entities: [member, skill, workspace],
		junctions: [
			junction({ pattern: 'Junction', between: ['member', 'skill'] }),
			junction({
				pattern: 'Junction',
				between: ['workspace', 'member'],
				is_primary: false,
				expose_on_parent: { right: false },
			}),
		],
	},
];
