/**
 * Capability mixin contract (ADR-041, CAP-1)
 *
 * A **capability** is a pattern that layers onto an entity's repository instead
 * of being inherited as its base — `kind: 'capability'` in the pattern registry.
 * Codegen applies it as a TS mixin in the generated repository's `extends`
 * clause, either inline (`extends WithX(BaseRepository<Entity, typeof table>)`)
 * or, when two or more stack, through a generated `<Entity>ComposedBase`.
 *
 * These three types are the contract every capability mixin is written against.
 * They exist because the naive shapes do not survive the compiler, and the
 * failures are non-obvious (CAP-1 §M2–M4, measured against TS 6.0.3):
 *
 *   - the base constructor MUST take `(...args: any[])` — anything narrower is
 *     TS2545 ("a mixin class must have a constructor with a single rest
 *     parameter of type 'any[]'");
 *   - the entity slot of the constraint MUST be `any` — `unknown` and `never`
 *     were both measured and both reject a concrete repository;
 *   - `EntityOf` / `TableOf` MUST widen (`unknown` / `PgTable`) when the
 *     conditional does not match, NOT collapse to `never`. TypeScript checks a
 *     derived class's static side against the mixin instantiated at `any`, and
 *     `EntityOf<any>` resolving to `never` makes every generated
 *     `class X extends WithY(...)` fail TS2417.
 *
 * The `any`s below are the same two the shipped `WithAnalytics` mixin already
 * carries — the rest-parameter and the erased instance slot; they are the mixin
 * idiom, not erasure —
 * `EntityOf<TBase>` recovers the concrete entity type, so a capability method's
 * signature survives composition (CAP-1 §M7).
 *
 * Writing one:
 *
 * ```ts
 * export function WithMembership<TBase extends RepositoryCtor>(Base: TBase) {
 *   abstract class MembershipMixin extends Base {
 *     // Filled by the generated repository from `config: { Membership: {...} }`
 *     protected readonly membershipConfig?: MembershipConfig;
 *
 *     async members(id: string): Promise<Array<EntityOf<TBase>>> {
 *       // `baseQuery()` already carries tenant / soft-delete / userTracking
 *       // scoping — capability methods never take a scope parameter (charter I3).
 *       const rows = await this.baseQuery(eq(this.col('id'), id));
 *       return rows as Array<EntityOf<TBase>>;
 *     }
 *   }
 *   return MembershipMixin as TBase & typeof MembershipMixin;
 * }
 * ```
 *
 * A mixin may read the repository's `protected` surface (`this.table`,
 * `this.tableRef`, `this.col()`, `this.baseQuery()`, `this.scopeAnd()`) —
 * measured working through a generic base (CAP-1 §M1).
 *
 * See `docs/adrs/ADR-041-capability-composition-emission.md` and
 * `docs/specs/CAP-1.md` §4.
 */

import type { PgTable } from 'drizzle-orm/pg-core';
import type { BaseRepository } from './base-repository';

/**
 * Constructor constraint for a repository mixin's base.
 *
 * `any[]` is mandated by the language (TS2545) and `any` in the entity slot is
 * mandated by assignability — see the module doc.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type RepositoryCtor = abstract new (...args: any[]) => BaseRepository<any, PgTable>;

/** The repository instance type a mixin base constructs. */
export type RepositoryOf<TBase extends RepositoryCtor> =
	/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
	TBase extends abstract new (...args: any[]) => infer TRepo ? TRepo : never;

/**
 * The entity type of the repository being layered — `unknown` when it cannot be
 * recovered (which happens while the compiler checks the mixin at its
 * constraint). Widening here rather than collapsing to `never` is what keeps
 * the generated `extends` clause type-checking; see the module doc.
 */
export type EntityOf<TBase extends RepositoryCtor> =
	RepositoryOf<TBase> extends BaseRepository<infer TEntity, infer _TTable> ? TEntity : unknown;

/**
 * The concrete Drizzle table type of the repository being layered — falls back
 * to the non-generic `PgTable` for the same reason `EntityOf` falls back to
 * `unknown`.
 */
export type TableOf<TBase extends RepositoryCtor> =
	RepositoryOf<TBase> extends BaseRepository<infer _TEntity, infer TTable> ? TTable : PgTable;

/**
 * The constructor a capability mixin returns, typed by the surface it adds.
 *
 * A mixin compiled with declarations (every mixin shipped in `runtime/`) must
 * annotate its return type: TypeScript cannot emit the anonymous class type of
 * a mixin whose base carries `protected` members, and every repository base
 * does (TS4094, CAP-3). Annotate as `TBase & CapabilityCtor<TheSurface>`,
 * where `TheSurface` is an exported interface of the mixin's public members.
 * An interface cannot carry `protected` members, so a config property the
 * generated repository fills is public on such a mixin — the repository emits
 * it with `override readonly`, which also overrides a `protected` declaration
 * (a consumer-authored mixin compiled without declarations may keep that).
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type CapabilityCtor<TSurface> = abstract new (...args: any[]) => TSurface;
