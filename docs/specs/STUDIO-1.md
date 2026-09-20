# STUDIO-1 — the entity lens: clicking through records, and the flattened deep traversal (#717)

**Status:** Design — not implemented
**Date:** 2026-09-20
**Issue:** #717 · follows #698 (STUDIO-0, slices 1–3)
**Project:** #578
**Depends on:** STUDIO-0's server + UI, `packages/graph-components` (instance half),
**REL-1** (#586, in review), **REL-2** (#587, in review — PR #713), **REL-3** (#588, planned — *this spec proposes
its shape*), **TEN-1** (#585, not started), SCOPE-0 (#616, in review), ADR-043
**Governed by:** charter §4 · CLAUDE.md § Operating Principles

Owner, 2026-09-20, and he asks that it be read as a sketch: *"my ideas are initial plans but they're very high
level thoughts."* So this spec proposes an interaction rather than transcribing one, and §2 lists every place it
departs from his words so he can overrule cheaply.

Design only. No code.

---

## 1. The one hard question

Everything else here is UI. This is the part that is an **API design problem**:

> From `Acme`, `deals` then `activities` means *every activity under every deal of this account* — one flat list,
> each row showing which deal it came from. `Account.deals.activities()`.

That is a **roll-up across children**, and REL-2 cannot express it. REL-2 §4 defines the navigator's contract as:
*"The navigator accumulates an include tree and calls **one** of the above once."* An include tree returns
`account.deals[].activities[]` — a **tree**. The flat list is a different query with a different root.

§4 answers it as an API question and proposes the signature REL-3 should ship. **This UI is the driver for that
design, not a consumer of whatever REL-3 happens to build.**

---

## 2. Departures from the sketch

Short, so it is cheap to overrule. Each is a place I think the sketch is not quite right.

| # | Sketch | Proposed instead | Why |
|---|---|---|---|
| **D1** | Breadcrumb: `Acme › deals › Q3 renewal` | **Editable path chips** that *are* the query | A breadcrumb records where you walked; a path is a thing you can edit, truncate and re-run. The path expression is also the API being taught — making it the primary control means the UI teaches by being used, not by a caption beside it. |
| **D2** | Relations as facets with **live counts** — `deals (14)` | **No counts by default.** The list reports `showing 50 of 312` from its own query; a facet count is opt-in | Charter **I5**: *aggregation never rides relations; anything that counts over a to-many path goes through query-surface*. A count per facet is also N queries on every record view, on a page whose job is to feel instant. |
| **D3** | Flat list for the deep case | Flat list **plus a `group by parent` toggle** over the same result | One query answers both readings. "312 activities" and "Q3 renewal: 8, Expansion: 5, …" are the same rows pivoted, and the grouped view is usually the one that answers *why*. |
| **D4** | Instance graph as renderer for the main surface | Instance graph as a **docked overview**; a table is the main surface | A fan-out of 312 activity nodes is not a picture, it is a hairball. The graph is excellent for *shape* (where am I, what connects to what) and poor for *rows*. Both, with the right job each. |
| **D5** | "Where am I" answered by breadcrumb | Answered by the **schema graph with the active path lit** | Slice 1 already draws the schema graph. Lighting `Account → deals → Activity` on it says where you are *in the model*, which is the thing that is actually confusing, and it costs one prop on a component we have. |
| **D6** | The SQL pane | A **statement timeline** — every statement the interaction issued, with timing | Its most valuable job is proving the traversal was *one* statement (charter I4). A pane that shows one statement can't show you the day it becomes four; a timeline can, and that is exactly when you want to know. |
| **D7** | Layer explorer as a pillar (earlier draft of #717) | A side panel, last | Already the owner's correction; recorded so the earlier draft's framing is not resurrected. |

Not departures — taken as given: real guards exercised and never bypassed; one source of truth per fact; the server
shells the CLI or drives the generated app; honest degradation without a database.

---

## 3. The main surface — three shapes, then a choice

### Shape A — facet rail + list (the sketch, literally)

```
┌ Account · Acme Corp ───────────────────────── Acme › deals ──────────┐
│ FIELDS              │  deals                                14 rows  │
│  name   Acme Corp   │  ┌────────────────────────────────────────────┐│
│  tier   enterprise  │  │ Q3 renewal         $120k      proposal     ││
│  domain acme.com    │  │ Expansion FY26      $80k      qualified    ││
│                     │  │ Pilot               $15k      closed_won   ││
│ RELATIONS           │  │ …                                          ││
│  ▸ deals        14  │  └────────────────────────────────────────────┘│
│  ▸ contacts      3  │                                                │
│  ▸ child accts   2  │                                                │
│  ▸ activities    0  │                                                │
└─────────────────────┴────────────────────────────────────────────────┘
```

Honest about what it is: a tree-walker. Clicking `deals` lists deals; clicking a deal re-roots. **The deep case is
an afterthought** — there is nowhere for `Account.deals.activities` to live except as a second click that silently
changes what the list means. It also puts counts on every facet, which §2 D2 argues against.

### Shape B — path bar + result table

```
┌──────────────────────────────────────────────────────────────────────────┐
│  [Account: Acme ×] › [deals ×] › [activities ×]        [+ hop ▾]  [Run]  │
│  Account.deals.activities                       ← the expression, shown  │
├──────────────────────────────────────────────────────────────────────────┤
│  view: (•) flat   ( ) group by deal      312 rows · 1 statement · 24 ms  │
├────────────────────┬─────────────┬──────────┬────────────────────────────┤
│  ACTIVITY          │ WHEN        │ TYPE     │ VIA DEAL                   │
├────────────────────┼─────────────┼──────────┼────────────────────────────┤
│  Call: renewal Q&A │ 2026-09-18  │ call     │ Q3 renewal            →    │
│  Email: quote v2   │ 2026-09-17  │ email    │ Expansion FY26        →    │
│  Note: pricing     │ 2026-09-17  │ note     │ Q3 renewal            →    │
│  …                                                     showing 50 of 312 │
└────────────────────┴─────────────┴──────────┴────────────────────────────┘
```

with the grouped reading of the *same* result:

```
│  view: ( ) flat   (•) group by deal                                      │
│  ▾ Q3 renewal            8 activities                                    │
│      Call: renewal Q&A      2026-09-18   call                            │
│      Note: pricing          2026-09-17   note                            │
│  ▾ Expansion FY26        5 activities                                    │
│  ▸ Pilot                 0 activities                                    │
```

The path is the control. Removing the `activities` chip returns you to the deals list; clicking `→` on a row
re-roots the lens there with a fresh path. `+ hop` offers only the relations that exist at the current leaf, from
the manifest — so an invalid path cannot be built.

### Shape C — canvas first, instance graph as the surface

```
                      ┌────────────┐
                      │  Acme Corp │ Account
                      └─────┬──────┘
             ┌──────────────┼───────────────┐
          deals          contacts      child accounts
        ┌────┴────┐      ┌───┴───┐      ┌────┴────┐
        │Q3 renew │      │ 3 ••• │      │ 2 •••   │
        └────┬────┘      └───────┘      └─────────┘
          activities
        ┌────┴──────────────────┐
        │  312 •••  (collapsed) │  ← the fan-out that cannot be drawn
        └───────────────────────┘
```

Beautiful for one hop, and it falls over exactly where the interesting case lives: the third level is 312 nodes,
so it collapses to a badge and you are back to needing a list. Keep the picture, demote it.

### The choice

**Shape B, with Shape C docked as an overview and Shape A's facet list folded into `+ hop`.**

```
┌──────────────────────────────────────────────────────────────────────────┐
│  [Account: Acme ×] › [deals ×] › [activities ×]        [+ hop ▾]  [Run]  │
│  Account.deals.activities                                                │
├───────────────────────────────────────────────┬──────────────────────────┤
│  view: (•) flat  ( ) group by deal            │  WHERE AM I              │
│  312 rows · 1 statement · 24 ms               │   ┌────┐  deals  ┌────┐  │
│  ┌──────────────────┬──────────┬───────────┐  │   │Acct│═══════▶│Deal│  │
│  │ Call: renewal Q&A│ call     │Q3 renewal │  │   └────┘        └──┬─┘  │
│  │ Email: quote v2  │ email    │Expansion  │  │                     ║    │
│  │ Note: pricing    │ note     │Q3 renewal │  │            activities║   │
│  └──────────────────┴──────────┴───────────┘  │                  ┌──▼─┐ │
│                          showing 50 of 312    │                  │Actv│ │
├───────────────────────────────────────────────┤                  └────┘ │
│ SCOPE   tenant [acme ▾]  user [—▾]  ☐ deleted │  (slice 1's schema graph,│
├───────────────────────────────────────────────┤   active path lit)       │
│ STATEMENTS                                    │                          │
│  1  24 ms  SELECT activities.* , deals.id …   │                          │
└───────────────────────────────────────────────┴──────────────────────────┘
```

Why B wins: the deep traversal is the point of the feature, and B is the only shape where it is a first-class
object rather than a state the list fell into. The path bar doubles as the API lesson (#717: *"the path expression
is shown as text beside the list, so the UI teaches the API"* — here it *is* the control, not a caption). And the
grouped view gives the parent-attribution reading for free.

---

## 4. The traversal API — what REL-3 must ship

### 4.1 Why the UI cannot do this itself

Two ways a UI could produce the flat list today, and both are wrong:

**(a) Fetch deals, then activities per deal.** Classic N+1 — 1 + 14 statements for Acme, and unbounded in the
number of deals. Violates charter **I4** (*a traversal is one statement*). Rejected on sight.

**(b) One REL-2 include (`with: { deals: { with: { activities: true } } }`), flattened in the client.** This is
*one* statement and every hop is correctly scoped, so it is **safe** — but it is not paginable, and that is fatal
for the surface in §3:

- **`limit` limits the wrong thing.** A limit inside a nested include is per-parent — "10 activities per deal" —
  not "the 50 most recent activities across all deals". The list in Shape B cannot be produced.
- **Ordering across the fan-out is impossible.** Each parent's children are ordered independently; there is no
  global `ORDER BY occurredAt DESC` over the union.
- **`312 rows` requires fetching all 312.** Every render of "showing 50 of 312" pulls the entire subtree over the
  wire and sorts it in memory. On a real account that is the whole activity history.
- **The page lies as it grows.** It works on demo data and degrades silently on real data, which is the worst
  failure mode a demo tool can have.

So: (a) is N+1, (b) is one unbounded statement. The third option — *one bounded statement rooted at the leaf* —
does not exist in the repository surface today. That is the gap.

**And it must not be built in the Studio.** A hand-rolled join in the Studio server would reintroduce precisely the
unscoped hop REL-2 §1.4 chose mechanism (a) to prevent: per-hop predicates come from `relationToSQL` applying each
relation's `where` to the target table. A join assembled anywhere else carries no hop scope, and would be a
cross-tenant leak wearing a UI. **The only correct home is the repository layer, where the relation definitions
and `hopScope` already live.**

### 4.2 Proposed signature

Two terminals on the navigator, sharing one path builder. The nested one is REL-2's existing contract; the
roll-up is the new thing.

```ts
// nested — REL-2 §4's contract, unchanged. Returns a tree.
await accounts.from(accountId).with('deals.activities').one();
//   => Account & { deals: Array<Deal & { activities: Activity[] }> }

// roll-up — proposed. Returns leaf rows, flat, with parent identity.
await accounts.from(accountId).path('deals.activities').rollup({
  limit: 50,
  cursor,                        // keyset, opaque
  orderBy: 'occurredAt desc',    // on the LEAF, across the whole fan-out
  where,                         // on the leaf
  via: 'identity',               // 'identity' (default) | 'full'
});
```

returning

```ts
interface RollupPage<TLeaf, TVia> {
  rows: Array<{
    node: TLeaf;                 // the activity
    via: TVia;                   // { deals: { id, label } } — one ref per intermediate hop
  }>;
  nextCursor: string | null;
  /** The statement actually executed — feeds Studio's SQL pane without a logger. */
  statement: { sql: string; params: readonly unknown[] };
}
```

compiling to one statement of the shape

```sql
SELECT activities.*, deals.id AS via_deals_id, deals.name AS via_deals_label
  FROM activities
  JOIN deals ON activities.deal_id = deals.id AND <hopScope(deals)>
 WHERE deals.account_id = $1
   AND <hopScope(activities)>
 ORDER BY activities.occurred_at DESC, activities.id DESC
 LIMIT 51;
```

### 4.3 The four things the signature has to settle

**1. The path expression.** Dot paths over relation keys — `'deals.activities'` — **the same vocabulary as REL-2's
allowlist paths** (REL-2 §5.1: *"`paths` are dot paths over relation keys"*). One vocabulary for the allowlist, the
navigator and the UI's chips means the allowlist can be consulted directly (§5.3) and the path shown in the UI is
literally the string passed to the API. Typed as a template-literal union derived from the relation manifest, so a
path that does not exist is a compile error, as REL-2 did for includes.

**2. Pagination across a fan-out.** **Keyset, on the leaf, with the leaf's primary key as tiebreak.** Because the
statement is rooted at the leaf table, `LIMIT` means what a reader expects — *the next 50 activities* — which is
the thing a nested include structurally cannot say. Offset paging is rejected for the usual reason (drift under
concurrent writes) and because the fan-out makes a stable total expensive. `nextCursor` is opaque and encodes
`(orderBy value, leaf id)`.

**No `total` by default.** A count over the fan-out is an aggregation over a to-many path — charter **I5** — and
belongs to query-surface, not here. Shape B's `showing 50 of 312` is therefore either opt-in, or the honest
`showing 50` with a `count` button. See D2 and §9.1.

**3. The shape of each row, including its parent.** `via` carries **one ref per intermediate hop**, keyed by the
relation name, each `{ id, label }`. Not the full parent row: a 50-row page would otherwise repeat a deal's every
column up to 50 times, for a column the table renders as one word.

`label` is not guessed — it comes from the target entity's declared display field. The entity schema already
carries `ui_key_field` / `ui_key_field_order`, so there is a declared source, and `via: 'full'` is available for
the case where the whole parent row is genuinely wanted. For a three-hop path, `via` has two keys.

**4. Depth and permission.**

- **Depth is uncapped internally**, matching REL-2 §2.3 exactly (*"charter I4 asks for one statement, not a shallow
  one; the depth cap is an HTTP concern only"*). Studio's lens calls the repository through the CLI (§5.1), so it
  is internal and uncapped.
- **Permission is REL-2's allowlist, and it governs HTTP.** Over HTTP the path must be a key of the route's
  compiled map or it is `400 { code: 'include_not_allowed', path }`. A roll-up exposed over HTTP needs its own
  allowlist entry — a `rollups:` sibling of `api.includes:` — because "may be embedded in a response" and "may be
  enumerated as a paged list" are different grants. **That is a REL-2/REL-3 boundary decision this spec raises and
  does not settle** (§9.2).
- **Scope is not optional and not separate.** Every join carries its hop's predicate via the same `relationToSQL`
  path REL-2 §1.4 chose. Under `strict` with no ambient tenant, building the query throws before any SQL is sent —
  REL-2 §1.5 already documents this as the intended fail-closed behaviour, and the lens surfaces the throw as the
  result (§5.2), which is the single most valuable thing it can show.

### 4.4 What this asks of REL-3

REL-3 is planned (#588) and unblocked, with REL-2 §4 as its handoff. That handoff describes **only** the nested
terminal. This spec asks REL-3 to ship **both terminals over one path builder**, and states plainly that the
roll-up is the harder and more valuable half:

- the nested terminal is a typed convenience over a capability REL-2 already shipped;
- the roll-up terminal is a **new capability** — a bounded, ordered, paginable read across a fan-out — that nothing
  in the stack can currently express, and that every "show me everything under this" question needs.

If REL-3 ships only the nested terminal, this lens cannot be built as designed, and the fallback is (b) above with
its pagination removed — a list that works on demo data and lies on real data. That is the trade to avoid.

---

## 5. The rest of the lens

### 5.1 How it executes

Unchanged from STUDIO-0's posture and #717's constraint: **the server shells the CLI**. A new verb —
`codegen query --entity account --id <id> --path deals.activities --json` — runs inside the demo project, so the
consumer's own `drizzle-orm` and `@nestjs/common` are the only copies loaded. Importing the generated repository
into the Studio process would mean two copies of each, which is the failure CLAUDE.md records by name (*"a
duplicate `drizzle-orm` broke table construction; a duplicate `@nestjs/common` turned every `NotFoundException`
into a 500"*, GATE-1 #599). One short-lived process per run; blast radius is that process.

### 5.2 Scope controls, exercising the real guards

Tenant, user and include-soft-deleted are controls in the pane. The runner sets them with `withRequester(...)` —
**the same boundary call the generated app makes** — and never bypasses the predicate.

The distinction worth stating on screen: TEN-1's guard has two halves. **Enforcement** (given a context, the
repository filters every hop) is exercised completely and honestly here. **Authorization** (who may claim a
context) lives in boundary middleware — TEN-1 is explicit that *"the repo trusts whatever the ambient context
says"* — so the lens is acting *as* a boundary, with the owner as the authenticator. It should say so. Slice 5
proves the other half, because there the context comes from a credential.

Two rules follow, and they are the point of the feature:

1. **No unscoped fallback, ever.** If the entity is tenant-scoped and no tenant is set under `strict`, the result
   is the thrown error, rendered as the result. Showing rows would invert the demonstration.
2. **`scopeEnforcement` is displayed, not chosen.** It comes from the project's config. A toggle would let the demo
   show lenient behaviour on a strict project.

### 5.3 The allowlist as a UI state

`+ hop` offers every relation the manifest carries. A path that REL-2's allowlist does not expose is offered but
**marked, with the reason** — `activities · not exposed over HTTP (no api.includes entry on list)` — rather than
being hidden or producing a raw 400.

An honesty note the sketch does not make: because the lens runs internally (§5.1), the allowlist is **advisory
here**, not enforcement. The path still runs. What the marking teaches is *"this works internally and would be
rejected over HTTP"*, which is exactly the distinction REL-2 draws and exactly what a reader needs before they
build a client against it. The real `400` belongs to slice 5, where a real request carries a real `?include=`.

### 5.4 The statement timeline

Every statement the current interaction issued, in order, each with its SQL, its parameters **shown separately
from the text** (interpolating them teaches injectable code), and its duration.

SQL text comes from the `statement` field the roll-up returns (§4.2) — no logger, no log parsing, and it is
available even when the query is not run (§5.5). Timing is wall-clock around the awaited call and is **labelled
`round-trip`**, because it includes driver and network, not planner time. `EXPLAIN ANALYZE` is a later opt-in
button, not the default: it executes the statement a second time.

The timeline is plural on purpose (D6). A traversal should be one row. The day it is four, the pane says so.

### 5.5 No database

- **`GET /api/capabilities`** reports what is actually available — database configured, database answering,
  generated app running, OpenAPI present — and each pane renders from it rather than probing or failing on use.
- **The empty state names the command:** *"The entity lens needs a database. Rebuild the demo with
  `just studio-demo-db`."* Not "unavailable" (STUDIO-0's runbook lesson).
- **Degrade to something honest.** Without a database the lens still shows the entity list, the relation graph,
  the buildable paths, and **the SQL a path would run** — building the statement needs no connection. Rows,
  timing and counts are explicitly disabled, not empty.
- **No mock rows, ever.** A tool whose purpose is showing what the system really does must not invent data.

---

## 6. The demo fixture

The deep case cannot be demonstrated by the current demo set (`account`, `contact`, `opportunity`, no rows). The
lens needs a shape **and** data.

**Entities** — add to `src/studio/demo/entities/`:

| Entity | Relations | Why it is needed |
|---|---|---|
| `account` | `parent_account` (self, belongs_to), `child_accounts` (has_many), `contacts`, `deals` | The self-reference gives the "child accounts" facet and a second deep path |
| `deal` | `belongs_to account`, `has_many activities`, `has_many contacts` (junction) | The middle hop of the headline path |
| `contact` | `belongs_to account`, junction to `deal` | A hop that is not the deep path, so the lens is not a single rail |
| `activity` | `belongs_to deal`, `belongs_to contact` (nullable) | **The leaf of `Account.deals.activities`** |

`opportunity` is renamed `deal` or kept and labelled — the owner says "deals/opps" interchangeably. Recommend
**`deal`**, because the path expression reads as the sentence: `Account.deals.activities`.

**Data**, and the shape matters more than the volume:

- ~3 accounts, one of them with **2 child accounts**;
- the primary account with **~14 deals**, deliberately uneven (one deal with many activities, several with a few,
  at least one with **zero** — an empty group is the case a grouped view gets wrong);
- **~300 activities** spread across those deals, with timestamps that interleave across parents, so
  `ORDER BY occurred_at DESC` across the fan-out visibly differs from per-parent ordering. This is what makes
  §4.1's argument visible rather than theoretical;
- **two tenants**, with the second tenant's rows interleaved, so changing the tenant control visibly removes rows
  rather than emptying the table;
- a few soft-deleted rows, so that toggle does something.

**Seeding is a new capability.** `just studio-demo-db` builds a schema and pushes it; nothing populates it. This
needs a seed step — recommend a `--seed` on the demo bootstrap emitting deterministic data (fixed ids and
timestamps) so screenshots and any future assertions are stable.

**This changes STUDIO-0's e2e.** `EXPECTED_EDGES_BEFORE` / `EXPECTED_EDGES_AFTER` in `test/studio/run-studio-e2e.ts`
are exact counts over the demo set; adding `activity` and the new relations moves both. The constants already carry
a comment saying they move with the fixture (added for #709). Same lockstep, one more caller.

---

## 7. Slices 5 and 6

**Slice 5 — request console.** The same traversals one layer up: call the generated routes with a chosen auth
context, driven from `/docs-json`, never a hand-maintained route list. Four things OpenAPI does not give, each real
work: a **real credential** (ADR-043 is closed by default; a bypass header would defeat what the console exists to
show), the **SQL a request caused** (request-scoped capture inside the running app — a correlation id plus the
Drizzle `logger` seam; the largest single piece and probably its own issue), **mutation safety** (OpenAPI lists
`DELETE` as readily as `GET`), and **seeded bodies** (a schema is not an example). This is also where allowlist
violations produce the real `400` (§5.3).

**Slice 6 — "what generated this" panel.** From an entity in the lens: the files it became, badged **generated**
vs **author seam**, with the family base class and stacked capabilities named. Both facts are already derivable —
the file set from the module-tree rule (NAME-0), the badge from the `@generated` banner every emitted file already
carries (measured: 140 of 146 baseline files; the six without are subsystem files, **a defect to fix rather than a
case to handle**). No generation-time file manifest: it would be a second source of truth (I1) that can go stale.
A panel, not a pillar.

---

## 8. What to build first

**In order: the REL-3 roll-up, then the lens on top of it, then the fixture alongside both.**

1. **Settle §4 with REL-3 first.** Not because of dependency bookkeeping but because the lens's shape is downstream
   of the answer: whether the deep list can be paged decides whether Shape B is honest. Building the UI first means
   building it against (b) and retrofitting pagination, which is the retrofit that never happens.
2. **The fixture (§6) can start immediately** and is useful on its own — it is the difference between a demo with
   three empty tables and one that looks like a CRM. It also unblocks judging the design against realistic fan-out.
3. **Then the lens**, in two steps: one hop first (`Account.deals` — a record, its relations, a paged list,
   re-rooting, the scope controls and the statement timeline, all of which work with REL-2 as it stands), then the
   multi-hop roll-up when §4 lands. Step one is genuinely useful alone and validates every pane except the one
   that needs the new API.
4. **Slice 5, then slice 6.**

The thing to resist: building the deep list on client-side flattening "for now". It demos identically and fails
exactly where the feature is supposed to prove the system is sound.

---

## 9. Open questions

1. **Where do facet counts come from, if they come at all?** (D2.) Counting over a to-many path is I5's
   query-surface territory. Options: omit (recommended for v1), lazy per-facet on demand, or a query-surface call
   once SEM-2 exists. Decide before the facet rail is built, because "a number next to each relation" is exactly
   the feature that quietly becomes N queries.
2. **Does a roll-up need its own allowlist entry over HTTP?** (§4.3.4.) "May be embedded in a response" and "may be
   enumerated as a paged list" are different grants, and REL-2's `api.includes` only says the first. Proposal: a
   `rollups:` sibling. This is a REL-2/REL-3 boundary call.
3. **Recursive paths are out of scope, and the fixture invites them.** `Account.childAccounts.deals` is one hop
   and fine; *"all deals under this account and its descendants"* is a recursive CTE and is **not** proposed here.
   Worth naming so it is a decision rather than an omission — the child-accounts facet will make someone ask on
   day one.
4. **Does `.toSQL()` work on the relational-query path** (REL-2's `with:`), or only on `select()`? Decides whether
   §5.5's no-database degradation covers nested includes or only the roll-up. Cheap to check; check it early.
5. **How is a demo credential minted for slice 5?** Needs an answer from ADR-043's owner. A real token is required;
   the mechanism is not decided here.
6. **Does the lens re-root by navigation or by path edit?** Both are offered in §3; if they diverge (clicking a row
   sets a *new* root vs *extends* the path) that is a UX decision worth making once, explicitly.

---

## 10. Charter invariants

- **I1 declare once.** Relations from REL-1's manifest, permitted paths from REL-2's allowlist, routes from
  `/docs-json`, scope from the real ALS, display labels from `ui_key_field`. §7 rejects a file manifest for the
  same reason.
- **I3 scope lives at the repository, at every hop.** §4.1 rejects a Studio-side join specifically because it
  would carry no hop predicate; §5.2 forbids an unscoped fallback.
- **I4 a traversal is one statement.** §4.1 rejects N+1 outright; §5.4's timeline exists to keep the promise
  visible.
- **I5 aggregation never rides relations.** D2 and §4.3.2 keep counts off the traversal path.
- **I6 HTTP is closed by default.** §4.3.4 and §9.2 treat exposing a roll-up as a grant that must be declared, not
  a side effect of the capability existing.
- **I9 gates are honest.** §5.5 forbids mock rows; §5.4 refuses to present round-trip time as query cost; §5.3
  states plainly that the allowlist is advisory in the lens and enforced over HTTP.
