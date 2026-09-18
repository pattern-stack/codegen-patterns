/**
 * `Communication` capability mixin (ADR-041.1, CAP-3)
 *
 * A communication-style entity — a meeting, an email, a message — is an
 * interaction with actors in **roles** (`host`, `attendees`, `about`). The
 * entity's `roles:` block declares them (CAP-2); codegen emits that block,
 * resolved to columns and junction tables, as `communicationConfig` on the
 * generated repository, and this mixin answers the two questions roles exist
 * for:
 *
 *   - `findByRole(role, actorId)` — the rows in which `actorId` occupies
 *     `role` (the meetings a contact attended / hosted);
 *   - `participants(id)` — every `(role, target, id)` of one row.
 *
 * Both are ONE statement (charter I4) and both run through the repository's
 * own `baseQuery()` / `scopeAnd()`, so tenant scope (ALS-fed, ADR-042) and
 * soft-delete apply exactly as they do to `findById` — no scope parameter
 * (charter I3).
 *
 * `participants` returns ids only. Role targets are different entities;
 * hydrating them is the relation graph's job (typed includes), not a second
 * mechanism here.
 *
 * The config is never authored: it is `@generated` from `roles:`.
 */
import { and, eq, exists, isNotNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { column } from './base-repository';
import type { CapabilityCtor, EntityOf, RepositoryCtor } from './capability-mixin';

/** A `cardinality: one` role — an FK column on this entity's own table. */
export interface OneRoleEdge {
	readonly cardinality: 'one';
	/** Actor entity name (the role's `target:`). */
	readonly target: string;
	/** camelCase key of the FK column on this table. */
	readonly column: string;
}

/** A `cardinality: many` role — a junction between this entity and the target. */
export interface ManyRoleEdge {
	readonly cardinality: 'many';
	/** Actor entity name (the role's `target:`). */
	readonly target: string;
	readonly via: {
		/** The junction's Drizzle table. */
		readonly table: PgTable;
		/** camelCase key of the junction column referencing THIS entity. */
		readonly self: string;
		/** camelCase key of the junction column referencing the actor. */
		readonly target: string;
	};
}

export type RoleEdge = OneRoleEdge | ManyRoleEdge;

/** Emitted on the repository as `communicationConfig` — keyed by role name. */
export interface CommunicationConfig {
	readonly roles: Readonly<Record<string, RoleEdge>>;
}

/** One participant of a communication: who, in which role, of which entity. */
export interface Participant {
	role: string;
	/** Actor entity name. */
	target: string;
	/** Actor id. */
	id: string;
}

/**
 * What `WithCommunication` adds to a repository — its public surface, stated
 * explicitly because a mixin shipped in the runtime is compiled with
 * declarations, and TypeScript cannot emit the anonymous class type of a mixin
 * over a base with `protected` members (TS4094). The config is therefore
 * public here; the generated repository fills it with `override readonly`.
 */
export interface CommunicationCapability<TEntity> {
	/** Filled by the generated repository from the entity's `roles:` block. */
	readonly communicationConfig?: CommunicationConfig;
	/** The rows in which `actorId` occupies `role`, under this repository's scope. */
	findByRole(role: string, actorId: string): Promise<TEntity[]>;
	/** Every participant of row `id`, across all roles, as ids. */
	participants(id: string): Promise<Participant[]>;
}

export function WithCommunication<TBase extends RepositoryCtor>(
	Base: TBase,
): TBase & CapabilityCtor<CommunicationCapability<EntityOf<TBase>>> {
	abstract class CommunicationMixin
		extends Base
		implements CommunicationCapability<EntityOf<TBase>>
	{
		readonly communicationConfig?: CommunicationConfig;

		/** The rows in which `actorId` occupies `role`, under this repository's scope. */
		async findByRole(role: string, actorId: string): Promise<Array<EntityOf<TBase>>> {
			const rows = await this.baseQuery(this.rolePredicate(role, actorId));
			return rows as Array<EntityOf<TBase>>;
		}

		/**
		 * Every participant of row `id`, across all roles, as ids. Empty when the
		 * row is not visible under the current scope.
		 */
		async participants(id: string): Promise<Participant[]> {
			const [first, second, ...rest] = Object.entries(this.roleEdges()).map(
				([role, edge]) => this.participantsBranch(role, edge, id),
			);
			if (!first) return [];
			const rows = second ? await unionAll(first, second, ...rest) : await first;
			return rows.map((r) => ({ role: r.role, target: r.target, id: r.id }));
		}

		/**
		 * "`actorId` occupies `role` on this row", as a predicate over this table —
		 * an FK comparison for a one-role, an `EXISTS` over the junction for a
		 * many-role. Composable into any scoped read of this repository.
		 */
		private rolePredicate(role: string, actorId: string): SQL {
			const edge = this.roleEdge(role);
			if (edge.cardinality === 'one') return eq(this.col(edge.column), actorId);
			const { self, target } = this.junctionColumns(edge);
			return exists(
				this.db
					.select({ one: sql`1` })
					.from(edge.via.table)
					.where(and(eq(self, this.col('id')), eq(target, actorId))),
			);
		}

		private participantsBranch(role: string, edge: RoleEdge, id: string) {
			// Every selected field is aliased: a set operation (`UNION ALL`) refers
			// to its branches' columns by name, and a raw `sql` field has none.
			const labels = {
				role: sql<string>`${role}::text`.as('role'),
				target: sql<string>`${edge.target}::text`.as('target'),
			};
			const guard = { softDelete: this.behaviors.softDelete };
			if (edge.cardinality === 'one') {
				const fk = this.col(edge.column);
				return this.db
					.select({ ...labels, id: sql<string>`${fk}`.as('id') })
					.from(this.tableRef)
					.where(this.scopeAnd(and(eq(this.col('id'), id), isNotNull(fk)), guard));
			}
			const { self, target } = this.junctionColumns(edge);
			return this.db
				.select({ ...labels, id: sql<string>`${target}`.as('id') })
				.from(edge.via.table)
				.innerJoin(this.tableRef, eq(this.col('id'), self))
				.where(this.scopeAnd(eq(self, id), guard));
		}

		private roleEdges(): Readonly<Record<string, RoleEdge>> {
			const roles = this.communicationConfig?.roles;
			if (!roles) {
				throw new Error(
					`${this.constructor.name}: the Communication capability has no roles — ` +
						'communicationConfig is generated from the entity YAML `roles:` block; regenerate.',
				);
			}
			return roles;
		}

		private roleEdge(role: string): RoleEdge {
			const roles = this.roleEdges();
			const edge = roles[role];
			if (!edge) {
				throw new Error(
					`${this.constructor.name}: no role '${role}'. Declared roles: ` +
						`${Object.keys(roles).join(', ')}.`,
				);
			}
			return edge;
		}

		private junctionColumns(edge: ManyRoleEdge): { self: PgColumn; target: PgColumn } {
			const owner = `${this.constructor.name} (junction)`;
			return {
				self: column(edge.via.table, edge.via.self, owner),
				target: column(edge.via.table, edge.via.target, owner),
			};
		}
	}
	return CommunicationMixin;
}
