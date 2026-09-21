// CONSUMER-OWNED, not generated — the FE-REL type gate.
//
// `tsc` proving the emitted tree COMPILES (FE-0) does not prove the emitted
// types are USEFUL: a graph accessor typed `any` everywhere would compile
// perfectly and be worthless. So this file is written the way a consumer would
// write it, and every claim FE-REL §5 makes is asserted here as a real
// assignment or a real `@ts-expect-error`.
//
// `@ts-expect-error` is load-bearing in both directions: `tsc` fails if the
// line below it stops being an error, so these cannot silently rot into
// no-ops. An emitter change that loosened the include type would fail this
// file, not pass it.
//
// It lives beside the `@repo/db/entities` fixtures because it is the same kind
// of thing — consumer code the smoke compiles against the generated tree.
import {
	graph,
	useAccountGraph,
	useOpportunityGraph,
	useTagGraph,
} from '../apps/frontend/src/generated/graph/index';
import type { Account } from '../consumer/account';
import type { Opportunity } from '../consumer/opportunity';
import type { OpportunityTag } from '../consumer/opportunity_tag';
import type { Tag } from '../consumer/tag';

export function typeGate(id: string): unknown {
	// ── §5: a to-one hop is `T | undefined`, a to-many is `T[]` ──────────────
	const a = useAccountGraph(id, { parentAccount: true, opportunities: true });
	const parent: Account | undefined = a.data?.parentAccount;
	const opps: Opportunity[] | undefined = a.data?.opportunities;
	// Root fields come through unchanged.
	const name: string | undefined = a.data?.name;

	// A left-joined to-one is NOT narrowed to the bare type.
	// @ts-expect-error `parentAccount` may be absent
	const notNarrowed: Account = a.data?.parentAccount as Account | undefined;

	// ── §5: a relation that was not included is not on the type ─────────────
	// @ts-expect-error `opportunities` was not included in this call
	useAccountGraph(id, { parentAccount: true }).data?.opportunities;

	// ── §5: a misspelled relation name is a compile error ───────────────────
	// @ts-expect-error no relation called `opportunites`
	useAccountGraph(id, { opportunites: true });

	// ── §4.2 depth 2: a to-one of a branch target nests into that branch ────
	const nested = useAccountGraph(id, { opportunities: { with: { account: true } } });
	const branchAccount: Account | undefined = nested.data?.opportunities[0]?.account;

	// ── §5: a misspelled NESTED relation name is a compile error too ────────
	// @ts-expect-error no relation called `accont` on the branch target
	useAccountGraph(id, { opportunities: { with: { accont: true } } });

	// ── the junction hop: `through` the link table, typed as the far side ───
	const o = useOpportunityGraph(id, { tags: true, opportunityTags: true });
	const tags: Tag[] | undefined = o.data?.tags;
	// …and the link rows themselves, where `role` lives.
	const links: OpportunityTag[] | undefined = o.data?.opportunityTags;
	const role: 'primary' | 'secondary' | undefined = o.data?.opportunityTags[0]?.role;

	// The junction contributes edges to BOTH parents, though neither YAML names
	// the other: `tag` declares no relationships at all.
	const backFromTag: Opportunity[] | undefined = useTagGraph(id, {
		opportunities: true,
	}).data?.opportunities;

	// ── §3: the descriptor is a real runtime value, keyed like the server ───
	// Collection keys are `entity.plural`; relation keys are the YAML names.
	const target: 'opportunities' = graph.accounts.opportunities.target;
	const via: 'opportunityTags' = graph.opportunities.tags.through.collection;
	const optional: true = graph.accounts.parentAccount.optional;

	return {
		parent,
		opps,
		name,
		notNarrowed,
		branchAccount,
		tags,
		links,
		role,
		backFromTag,
		target,
		via,
		optional,
	};
}
