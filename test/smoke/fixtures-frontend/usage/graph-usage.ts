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
import * as entityHooks from '../apps/frontend/src/generated/entities/index';
import {
	graph,
	type MeetingWithBase,
	useAccountGraph,
	useMeetingGraph,
	useMeetingsWithBase,
	useMeetingWithBase,
	useOpportunityGraph,
	useTagGraph,
} from '../apps/frontend/src/generated/graph/index';
import type { Account } from '../consumer/account';
import type { Communication } from '../consumer/communication';
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

	// ── RFC-0006 §3.4 (A13): a child's hop to its base is INNER-joined ──────
	// The child row does not exist on the client until its base does, so the
	// hop is never absent and its type carries no `| undefined`.
	const m = useMeetingGraph(id, { communication: true, transcripts: true });
	// Inferred, never annotated: these read the type the accessor really emits.
	const hop = m.data!.communication;
	// A real assignment: it fails to compile if the hop is `Communication | undefined`.
	const meetingBase: Communication = hop;
	// Both halves of the flat row read as one: the base's `occurredAt`, the child's `title`.
	const occurredAt: Date = m.data!.communication.occurredAt;
	const title: string = m.data!.title;
	// @ts-expect-error the hop is required, so this is NOT `'optional'` — and tsc reports an unused expect-error (TS2578) the moment the hop is left-joined
	const hopIsOptional: undefined extends typeof hop ? 'optional' : 'required' = 'optional';
	// A child's OTHER hops stay left-joined: a transcript's `meeting` is still `| undefined`.
	const transcriptMeeting = useMeetingGraph(id, { transcripts: { with: { meeting: true } } }).data!.transcripts[0]!
		.meeting;
	const otherHopIsOptional: undefined extends typeof transcriptMeeting ? 'optional' : 'required' = 'optional';

	// …and `useMeetingsWithBase()` is the flat list: `MeetingWithBase[]`.
	const meetings: MeetingWithBase[] = useMeetingsWithBase().data;
	const first: MeetingWithBase | undefined = meetings[0];
	const flatOccurredAt: Date | undefined = first?.occurredAt; // base column
	const flatTitle: string | undefined = first?.title; // child column
	const one: MeetingWithBase | undefined = useMeetingWithBase(id).data;
	// @ts-expect-error a field that is on neither the base nor the child
	meetings[0]?.nonsense;

	// ── S5: the base of every-kind-has-a-child has no create route ──────────
	// `communication_part` has a child for each of its kinds, so the backend
	// generates no `POST /communication_parts` and the frontend must not emit a
	// mutation aimed at it. `communication` keeps `message` as a base-only kind,
	// so it still has one.
	const hasCreateForCommunication = entityHooks.useCreateCommunication;
	const hasUpdateForPart = entityHooks.useUpdateCommunicationPart;
	// @ts-expect-error no `useCreateCommunicationPart`: its create route does not exist
	entityHooks.useCreateCommunicationPart;

	return {
		meetingBase,
		occurredAt,
		title,
		hopIsOptional,
		otherHopIsOptional,
		flatOccurredAt,
		flatTitle,
		one,
		hasCreateForCommunication,
		hasUpdateForPart,
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
