# Lane: api-surface-plan — implementation plan for the backend API-surface model (slice 1) + Studio API view

You are a **planning** lane. Produce a plan, not code. Read-only on source: do not edit anything outside
`.ai-docs/stacks/api-surface-model/`, do not create branches, commits, issues or PRs, and do not start sub-agents.

**Deliverable:** `.ai-docs/stacks/api-surface-model/PLAN.md`.
**When done or stuck:** report with `SendMessage` to `codegen-patterns-7f` (hc terminal `t1hz`), one short paragraph
plus the path. If that name doesn't resolve, find the lead with `ListAgents` (names start `codegen-patterns-`) and
check it against `hc get t1hz`.

---

## 1. Background — why this exists

Doug (owner) wants Studio (`codegen studio`, `src/studio/**` + `tools/studio/**`, specs `docs/specs/STUDIO-0.md`,
`STUDIO-1.md`) to show each entity's **generated API**, not just its data model:

- an **API tab** per entity: repository methods, service methods, HTTP routes, include allowlists — each annotated
  with the YAML line it came from (`← relationships.account`, `← queries[1] (unique)`, `base`);
- **methods on edges**: selecting `contact ──belongs_to──▶ account` lists what that one relationship generates on
  *both* sides (`Contact.findByAccountId`, `Contact.service.account()`, `Account.service.contacts()`, include keys);
- later (NOT this plan): a reachability view, then executing paths (overlaps STUDIO-1 / REL-3).

The blocker surfaced while scoping it: **those names have no single owner.** They are decided in three places:

- `deriveQueryMethodName` / `processQueries` / `processBelongsTo` / `processHasMany` inside the ~2,600-line
  `templates/entity/new/backend/entity-locals.js` (`buildBackendLocals`), which produces template-shaped locals,
  not a model;
- inline in the EJS: `findBy<CamelField>` is assembled in `repository.ejs.t`; service relation methods
  (`rel.relationKey`, `rel.name`, camel-casing via `.replace(/_([a-z])/g…)`) in `service.ejs.t`;
  the backend templates hold roughly 375 lines of logic in total (repository ~75, service ~70);
- routes are hard-coded in `controller.ejs.t`; include paths are resolved separately in
  `src/emitters/relations/build-includes.ts`.

Studio's rule (CLAUDE.md § Studio) is that it **never reimplements generation**. So Studio cannot derive
`findBy…` itself — it would be a second copy that drifts.

## 2. The agreed direction — "model first, renderers print"

Doug has aligned on this pattern (his "one owner, many surfaces" principle applied to the generator itself):

```
YAML ─► parse/validate ─► MODEL (typed TS, one owner per fact) ─► surfaces
                                                                  ├─ backend hygen templates (print only)
                                                                  ├─ Studio API tab / edge view
                                                                  └─ docs / tests that ask "what exists?"
```

Rules:
1. Every name and every "does this exist" decision is made **once**, in the model.
2. The model is typed TypeScript, testable without rendering.
3. Templates **only print**: loop over the model, branch on its flags; never build a name, camel-case, or decide
   existence.

Precedent in-repo, to mirror rather than invent: the frontend's `buildClientGraph` → `emit-graph.ts`
(`src/emitters/frontend/graph-model.ts`), and REL-1's `buildRelationGraph` (`src/emitters/relations/build-graph.ts`),
which the frontend reuses instead of re-walking YAML.

**Incremental, not big-bang.** The cleanup goes slice by slice; the model owns only what it has taken over. Each
refactor slice must leave `just test-baseline` snapshots **byte-identical** — that is the proof of no behavior
change. No hygen → TS-emitter migration in scope.

Rough slice list (from the conversation; you may revise with reasons):

| Slice | Takes over |
|---|---|
| **1. API surface** (this plan, in full detail) | method names; which finders / relation methods exist; routes; include allowlists |
| 2. Columns / fields | Drizzle column + DTO decisions |
| 3. Module wiring | providers, imports, tokens |

## 3. What to plan

**In full detail:** slice 1 + the Studio API view that consumes it. **In outline only:** slices 2–3 (enough that
Doug can decide whether to continue — scope, risk, rough size, what they'd share with slice 1).

The plan must answer, from the code (cite `file:line`), not from this brief:

1. **Inventory.** Every API-surface fact slice 1 must own, and exactly where each is decided today (entity-locals,
   which template lines, build-includes, controller). Include: base reads (`findById`, `list`, `count`, and
   READ-1's `findByIds` + `{ columns, with }` options), `queries:` finders (plain, unique, ordered, `via:` /
   `select:`, `name: search`), `belongs_to` finders, service to-one / to-many relation methods, use-case classes,
   controller routes incl. `with-fields` and search controller, `api: false` / `api: { enabled, includes }`,
   junction fan-out methods (`templates/_shared/junction-fan-out.mjs`), family base classes, capability/pattern
   methods if they surface. Say which are in scope for slice 1 and which you defer, with reasons.
2. **The model's shape.** A typed TS type (sketch it) — per entity: repository / service / use-cases / http, each
   entry with name, kind, signature-level info worth showing, and **provenance** (which YAML path produced it).
   Where it lives (`src/…`), what it takes as input (single entity vs whole set — relation methods on the *target*
   need the whole graph; reuse `buildRelationGraph` / the entity registry rather than re-walking YAML), and how
   hygen's `prompt.js` / `buildBackendLocals` reach it (templates are JS/EJS loading TS — check how they already
   import TS today, e.g. `templates/_shared/entity-naming.mjs`, `src/config/file-naming.ts`).
3. **Template conversion.** For each template touched: which inline derivations are replaced by reads from the model.
   Byte-identical baseline output is the gate for every step.
4. **Studio.** The server route (or extension of `GET /api/graph`) — in-process like the graph route, per STUDIO-0 §2;
   the contract types in `src/studio/shared/api.ts` (types only, no runtime imports); the UI: API tab in
   `tools/studio/src/inspector/`, edge method list on the canvas. Keep colours on Studio tokens (CLAUDE.md § Studio
   theming).
5. **A gate that can fail on its own subject** (CLAUDE.md § Testing, #726): e.g. every method the model lists exists
   in the generated baseline output, and every generated public method is listed. Say how it fails if someone adds a
   method in a template without the model.
6. **The enforcement rule** to add to CLAUDE.md ("templates never derive a name or decide existence") and whether a
   cheap automated check is feasible (e.g. a lint over `templates/**` for `.replace(/_([a-z])/` / string-built
   `findBy`), with a named allowlist for what is not yet migrated.
7. **Docs.** An ADR (next number after ADR-045 in `docs/adrs/`) recording the pattern, and a `docs/specs/STUDIO-2.md`
   for the Studio view — say what each contains; you may draft them as appendices in PLAN.md, not as files in docs/.
8. **PR breakdown.** PR-sized, dependency-ordered, each with: scope, files, the gate that proves it, rough size.
   Stacked via gh stack is the norm here; batches land atomically.
9. **Sequencing vs. in-flight work.** The READ-1 stack (11 PRs ending at #859; also #839, #847, #854–#857, #858,
   #860, #861) changes exactly this surface (`{ columns, with }` on every read, `findByIds`, `cursor` removed from
   relation finders). Read `gh pr view 859` and `docs/specs/READ-1.md` on that branch
   (`git show origin/dugshub/codegen-read-api:docs/specs/READ-1.md`). Plan on top of READ-1 landed; say what, if
   anything, can start before it merges.
10. **Risks and open questions** for Doug — numbered, each with your recommended answer.

## 4. Constraints (from CLAUDE.md — read it in full first)

- No backwards compatibility; replace cleanly, no shims or deprecated paths.
- Charter `.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md` §4 invariants bind this work (it touches
  repositories/services and the frontend-adjacent relation graph). Read it.
- Studio server never reimplements generation; contract file is types-only.
- Emitted names follow `src/config/file-naming.ts`; cross-entity names come from `templates/_shared/entity-naming.mjs`
  (NAME-0) — never `pluralize()` or hand-built paths.
- "Narrowing a spread to an explicit key list is a silent-drop hazard" — relevant when templates stop reading
  locals they used to compute.
- Keep slice 1 tight. If you find the honest slice 1 is much bigger than ~3–4 days, say so plainly and propose a
  smaller first cut rather than quietly growing it.

## 5. Format

PLAN.md, written for Doug to read: plain language first, then detail. Lead with a one-screen summary (what, why,
PR list with sizes, the key decisions you need from him). Use tables for inventories and PR lists. Cite code as
`path:line`. No filler.
