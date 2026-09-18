/**
 * `Actor` capability mixin (ADR-041.1, CAP-3)
 *
 * Marks an entity as something a role may point at (a contact, an account) and
 * says what kind of actor it is:
 *
 *   - `individual` — one actor;
 *   - `group` — an actor made of members, reached through one of its own
 *     `has_many` relationships (`members: contacts`).
 *
 * `memberPredicate(actorId)` is "this row is, or contains, actor `actorId`" as
 * a predicate over THIS table: the identity predicate for an individual; for a
 * group, an `EXISTS` over the member table. Because it is over this table it
 * composes into this repository's own scoped reads
 * (`list({ where: repo.memberPredicate(contactId) })` → the accounts a contact
 * belongs to), so tenant scope and soft-delete apply to the rows returned
 * (charter I3). The member hop is a membership test on the FK and returns no
 * member rows.
 *
 * The config is `@generated`: `kind` from `config: { Actor: { kind } }`, the
 * member table and FK resolved from the named `has_many`.
 */
import { and, eq, exists, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { column } from './base-repository';
import type { CapabilityCtor, RepositoryCtor } from './capability-mixin';

export interface IndividualActorConfig {
	readonly kind: 'individual';
}

export interface GroupActorConfig {
	readonly kind: 'group';
	readonly members: {
		/** The member entity's Drizzle table (the `has_many` target). */
		readonly table: PgTable;
		/** camelCase key of the member table's FK back to this entity. */
		readonly foreignKey: string;
	};
}

/** Emitted on the repository as `actorConfig`. */
export type ActorConfig = IndividualActorConfig | GroupActorConfig;

/**
 * What `WithActor` adds to a repository — stated explicitly for declaration
 * emit (see `CommunicationCapability`); the config is public for that reason.
 */
export interface ActorCapability {
	/** Filled by the generated repository from `config: { Actor: {...} }`. */
	readonly actorConfig?: ActorConfig;
	/** "This row is, or contains, actor `actorId`" — over this table. */
	memberPredicate(actorId: string): SQL;
}

export function WithActor<TBase extends RepositoryCtor>(
	Base: TBase,
): TBase & CapabilityCtor<ActorCapability> {
	abstract class ActorMixin extends Base implements ActorCapability {
		readonly actorConfig?: ActorConfig;

		/** "This row is, or contains, actor `actorId`" — over this table. */
		memberPredicate(actorId: string): SQL {
			const config = this.actorConfig;
			if (!config) {
				throw new Error(
					`${this.constructor.name}: the Actor capability has no config — ` +
						"declare `config: { Actor: { kind: individual | group } }` on the entity YAML.",
				);
			}
			if (config.kind === 'individual') return eq(this.col('id'), actorId);
			const { table, foreignKey } = config.members;
			const owner = `${this.constructor.name} (members)`;
			return exists(
				this.db
					.select({ one: sql`1` })
					.from(table)
					.where(
						and(
							eq(column(table, foreignKey, owner), this.col('id')),
							eq(column(table, 'id', owner), actorId),
						),
					),
			);
		}
	}
	return ActorMixin;
}
