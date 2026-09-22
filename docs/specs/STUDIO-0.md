# STUDIO-0 — Studio: the model graph, the YAML and generation in one browser window (#698)

**Status:** Slice 1 implemented · slices 2–3 open
**Date:** 2026-09-20 · **Implemented:** 2026-09-20
**Issue:** #698
**Project:** #578
**Depends on:** CLI-1 (#673 — every verb has a `--json` payload; the Studio drives the CLI rather than
reimplementing it), the graph component library (`docs/specs/graph-component-library.md`), `tools/schema-graph-viewer`
(the canvas the Studio's graph pane is descended from), `serializeDomainGraph` (`src/analyzer/serialize-graph.ts`)
**Coupled to:** #679 (collapsing `pattern: Junction` and `relationship:` into one concept) — see §5
**Governed by:** charter (`.ai-docs/stacks/relations-v2-and-semantic-model/PROJECT.md`) §4 · CLAUDE.md § Operating
Principles

Owner asked for this on 2026-09-20: one local browser window where the model, the YAML, generation and — eventually —
the live data sit together, so relations can be demonstrated end to end without switching to a terminal.

---

## 1. The loop it must make possible

> Add a relationship in a form → click Generate → see the new edge in the model graph → follow it on real records in
> the explorer. No terminal.

Slice 1 delivers all of that except the last hop. The data explorer is slice 3 and is **not built** (§4).

---

## 2. Architecture

Three parts, split so that no part reimplements another's knowledge.

```
src/studio/shared/api.ts        the wire contract — types only, no runtime imports,
                                imported by BOTH halves (the UI via @studio-shared)
        │
src/studio/server/**            HTTP server. Owns no generator logic: every mutating
        │                       route shells the codegen CLI with --json and parses it.
        │                       Read routes call the analyzer in-process.
        │
tools/studio/**                 Vite + React app. Owns no generator logic either: it
                                renders @pattern-stack/graph-components onto an
                                @xyflow/react canvas and talks to the server.
```

### Why the server shells the CLI

The CLI is the contract the repo already gates (`just test-smoke`, `just test-baseline`, the tarball smoke). A server
that called the hygen pipeline directly would be a second way to generate, with its own bugs and no gate — and every
future CLI change would need porting. Shelling `entity new --all --force --json` means the Studio's Generate button
and the owner's terminal run the same code path, and the `--json` payloads CLI-1 (#673) added to every verb are what
makes that legible over the wire rather than screen-scraped.

The one place the server does *not* shell out is the graph: `GET /api/graph` calls `analyzeDomain` +
`serializeDomainGraph` in-process, because `project graph --json` would only re-serialize the same structure through a
subprocess.

### Why the UI reuses graph-components

`packages/graph-components` was built (graph-component-library spec) to serve **two** views from one set of
components — the schema graph and a future instance graph. The Studio's graph pane is the schema view of exactly those
components on an `@xyflow/react` canvas with `elkjs` layout, the same composition `tools/schema-graph-viewer` uses.
When slice 3 adds the data explorer, its instance graph is the second view of the same components, not a new library.

---

## 3. The API contract as implemented

Source of truth: `src/studio/shared/api.ts`. Both halves import it, so a change there is a change both sides
typecheck against. It is types-only by construction — a runtime import would pull the generator into the browser
bundle.

| Route | Request | Response | Notes |
|---|---|---|---|
| `GET /api/health` | — | `HealthResponse` | `{ok, projectDir, cliVersion}` |
| `GET /api/graph` | — | `GraphResponse` | `{graph, entities, junctions, relationships}` — the counts are **siblings** of `graph`, because `SerializedDomainGraph.entities` is already the entity map |
| `GET /api/files` | — | `StudioFile[]` | `{kind: 'entity'\|'junction'\|'relationship'\|'config', path, name}` |
| `GET /api/files/:path` | — | `FileReadResponse` | `:path` is the URL-encoded project-relative path |
| `PUT /api/files/:path` | `{content}` | `{ok:true}` or **422** `{issues}` | see §3.1 |
| `POST /api/validate` | — | `ValidateResponse` | whole-project validate |
| `POST /api/relationships` | `RelationshipRequest` | `{preview: [{path, content}]}` | **dry run — writes nothing** |
| `PUT /api/relationships` | `RelationshipRequest` | `{written: string[]}` | same body, files written |
| `POST /api/generate` | `{steps}` | **202** `{runId}`, or **409** `RunConflictResponse` | one run at a time |
| `GET /api/runs/:id/stream` | — | SSE of `RunEvent` | see §3.2 |
| `GET /api/diff` | — | `DiffResponse` | working tree vs `HEAD` |

**The canvas's counts are not the API's, deliberately.** `GET /api/graph` reports a first-class relationship as
*one* `N:M` edge between its endpoints — after the demo's relationship lands, `graph.edges.length` is 5. The canvas
draws that relationship as a **node** with an edge to each endpoint, so it reads `4 nodes · 6 edges`. Both are
correct for their purpose: a first-class relationship carries its own fields, types and temporal/sourced flags, so
the canvas needs somewhere to render them, while the API describes the domain graph rather than a drawing of it.
The e2e asserts the API's numbers (§6.2), and the adapter's own tests
(`tools/studio/src/__tests__/schema-adapter.test.ts`) pin the translation with both sets named — 3 entities and 5 API
edges become 4 nodes and 6 edges, the extra node is the relationship rather than an entity, and no direct
`contact → opportunity` edge is drawn *alongside* the junction's two. So the divergence is gated from both sides:
anyone "fixing" it meets a test that explains why it is deliberate, rather than one that looks like a stale
expectation to bump.

Files are addressed **generically by path**, not per noun (`/api/files/entities%2Fcontact.yaml`, not
`/api/entities/contact`). That is deliberate: the editor pane is one editor over four kinds of YAML, and a per-noun
route set would have to grow a fifth route the day a fifth kind appears. `StudioFileKind` carries the distinction as
data instead.

### 3.1 Validation and the 422

`PUT /api/files/:path` validates before writing; a rejected write leaves the file on disk untouched. Three decisions
the build settled:

1. **The issues are real Zod issues.** The server runs `EntityDefinitionSchema.safeParse(parseYaml(content))` itself
   and narrows `result.error.issues` to `ZodIssueLike = {path, message, code}`. It does **not** go through
   `loadEntityFromYaml`, which flattens errors to `details: string[]` via `formatZodErrors` — by the time that loader
   returns, the issue objects are gone and the UI could not map an error back to a line.
2. **The schema is picked by directory + `detectYamlType`** — `EntityDefinitionSchema`, `JunctionDefinitionSchema`,
   `RelationshipDefinitionSchema` or `CodegenConfigSchema`.
3. **YAML syntax errors use the same channel.** `parseYaml` throws before Zod ever runs, and the contract had no shape
   for that. Decided: 422 with a single synthesized issue, `{path: [], code: 'custom', message: <parser text including
   line and column>}`. The UI therefore has one error channel, not two. A `400` in this API means the *request* was
   malformed (bad path, traversal attempt), never that the content was.

### 3.1b The origin model, and binding somewhere reachable

The API is unauthenticated; **the bind address is the security boundary**, and the `Origin` check is what stops a
page on another site from driving the owner's generator through their browser. A state-changing request whose
`Origin` is present and foreign is refused 403 before any handler runs. A request with *no* `Origin` is allowed —
a non-browser client cannot be the victim of the attack this defends against, and a browser always sends one on a
cross-origin write, so its absence cannot be forged into an attack.

`codegen studio` takes `--host` (default `127.0.0.1`) and a repeatable `--allow-origin`, so an owner working on a
remote box can reach it. The property that makes that safe:

> **Widening the bind does not widen the allowlist.**

`selfOrigins(host, port)` rebuilds the accepted origins from the address actually bound. A loopback bind accepts
the three loopback spellings; a specific non-loopback bind accepts **only that address**; a wildcard bind
enumerates this machine's real interface addresses rather than waving everything through. `--allow-origin` exists
for the one case the address cannot cover — a browser reaching the server **by name**, where the `Origin` carries
the name — and takes exact origins only. No wildcards, no `*`: a pattern language in an allowlist is how the
allowlist quietly becomes "allow anything".

Verified against a real non-loopback bind (`--host 10.88.111.45 --port 5182`), a `PUT /api/files/:path` with the
same valid body each time:

| `Origin` | Result |
|---|---|
| `http://10.88.111.45:5182` (the bound address) | **200** |
| `http://127.0.0.1:5182` (now stale) | **403** |
| `https://evil.example` | **403** |
| *(absent)* | **200** |

The second row is the load-bearing one: binding wider did not leave the old loopback origin accepted.

**Why this is first-class rather than a proxy recipe.** The obvious workaround — put a header-rewriting proxy in
front — "works" by forging the `Origin` the check reads. That defeats the control rather than satisfying it, and
it would have left the documentation recommending that owners disable their own CSRF protection to use the tool.
Supporting the bind directly keeps the check meaningful on every path.

The default posture is unchanged and gated as such: loopback bind, no extra origins. The e2e (§6) runs against it
and asserts both directions — a same-origin write succeeds, a foreign one is refused.

### 3.2 Runs are two-step, and the stream ends explicitly

`POST /api/generate` returns **202** with a `runId` — the run is accepted and proceeds asynchronously, and its
result arrives on the stream rather than in that response. `GET /api/runs/:id/stream` is the SSE. Frames are `data: <json>` with a `type`
discriminant — `{type:'log',line}`, `{type:'step',name,status}`, and terminally `{type:'done',ok,diff}`, after which
the server closes the stream. The terminal signal is a **frame**, not the socket closing and not a quiet period, so a
consumer can distinguish "finished" from "hung" — which is what lets the end-to-end test (§6) fail a stalled run
instead of hanging CI.

`RunStepName` is `'generate' | 'dbPush' | 'restart'`; a second `POST /api/generate` while a run is in flight is a 409
naming the occupying run.

### 3.3 Two CLI behaviors the server must respect

Both were found by probing the real CLI during this build, and both would have shipped broken:

- **`--force` is mandatory on the generate legs.** `checkGitSafety` fails `entity new` / `relationship new` with exit
  1 when any file under the generated-output roots is dirty. The demo project is git-backed (it has to be — `/api/diff`
  reports the working tree against `HEAD`), so the *first* Generate leaves the tree dirty and the *second* would be
  refused with `Uncommitted changes in N generated-output files. Pass --force to overwrite.` The run step therefore
  invokes `entity new --all --force --json`, and `relationship new --all --force --json` when the project has
  relationship YAMLs.
- **`/api/diff` must enumerate untracked files with `-uall`.** `git status --porcelain` collapses an untracked
  *directory* to one entry. On the demo project immediately after the relationship is generated, plain `--porcelain`
  reports 4 entries — two of them the bare directories `relationships/` and `src/modules/contact-opportunities/` —
  while `--porcelain -uall` reports 14, one per file. Since the point of the demo is watching a new module appear,
  the collapsed form would show a directory name and no patch. Untracked files also produce no `git diff` patch at
  all, so their patch is synthesized as all-added.

---

## 4. The three slices

| Slice | What | Status |
|---|---|---|
| **1** | Model graph + YAML editor + Generate | **Shipped** (#698) |
| **2** | Relationship form — pick two entities + a kind, preview the YAML, save | **Shipped as part of slice 1** — see below |
| **3** | Data explorer — the generated frontend embedded, records browsable, links attach/detach, instance graph live | **Not built** |

Slice 2 landed with slice 1 rather than after it. The reason is that slice 1's Generate button is only demonstrable if
there is something to generate, and hand-editing a relationship YAML in the editor pane to demonstrate the graph
updating would have made the editor the relationship UI by default — which is the outcome slice 2 exists to avoid. The
form and its preview were cheap once `POST`/`PUT /api/relationships` existed, so they shipped together.

**Slice 3 is not started.** No data explorer, no record browsing, no attach/detach, no instance graph. The demo stops
at "see the new edge in the model graph". Reaching the last hop needs the generated frontend (ADR-038, FE-REL #589)
running against a database the Studio boots, which is why it is its own slice and not a stretch of this one.

---

## 5. The #679 coupling — the relationship form is deliberately data-driven

#679 will collapse `pattern: Junction` and `relationship:` into one concept. Anything built now that hard-codes
today's four-way split would have to be unpicked then, in as many places as the split was spelled out.

So the split is **data in one file**, not control flow in several:

- `tools/studio/src/inspector/relationship-kinds.ts` holds one array of kind descriptors — the contract's
  `RelationshipKind` id, a label, a one-line description, the cardinality it draws, and which `RelationshipOptions`
  fields apply to it. The form, the option panel, the preview header and the graph legend all render *from that
  array*. None of them branches on `kind === 'many_to_many'`.
- `tools/studio/src/graph/edge-kinds.ts` is the same shape for the graph's edge vocabulary — colour, dash, width,
  arrowhead and legend copy per edge kind — with the legend **generated from the table**, so the legend cannot drift
  from what is drawn.

When #679 lands, collapsing the concepts is an edit to descriptors in those files. The test of whether this held is
mechanical: `grep` for a `RelationshipKind` literal outside `relationship-kinds.ts` should find nothing in the form,
the preview or the legend.

This is also why the server's relationship routes take `{from, to, kind, options}` rather than a YAML fragment: the
request says *what the user asked for*, and the server decides which file shape that is today. `many_to_many` writes a
first-class relationship YAML at `relationships/<from>_<to>.yaml`; `belongs_to` / `has_one` edit the from-entity's
YAML (and the to-entity's when `options.inverse` is set); `has_many` edits the from-entity's YAML. When #679 changes
those mappings, no caller changes.

---

## 6. The end-to-end proof — `just test-studio`

`test/studio/run-studio-e2e.ts` boots the real server against a real demo project and drives the owner's loop over
HTTP. No mocks; nothing stubs the generator.

### 6.1 The demo project

`src/studio/demo/materialize.ts` exports `materializeDemoProject({targetDir, git})`: `bun init -y` →
`codegen project init --yes --with-tsconfig --no-skills` → copy `src/studio/demo/entities/*.yaml` →
`codegen entity new --all --force` → `git init` + one baseline commit. It takes ~1.5s.

One definition, two consumers, on purpose: `just studio-demo` materializes it at a stable path for the owner, and
`just test-studio` materializes it into a private TMPDIR. If these were two fixture sets, the thing the test proves
and the thing the owner demos would drift, and the test would stop being evidence about the demo.

The demo set is three entities — `account`, `contact`, `opportunity` — with `account has_many {contacts,
opportunities}` and `contact` / `opportunity` each `belongs_to account`. **`contact ↔ opportunity` is deliberately
absent**: adding it is the demo.

Measured baseline: `entities: 3`, `relationshipDefinitions: 0`, `edges: 4`.
After the relationship: `entities: 3`, `relationshipDefinitions: 1`, `edges: 5`.

### 6.2 What the test asserts

Thirteen stages and 47 expectations, every one named and exact — an entity count, a Zod issue path, a file path, an edge's
cardinality. Nothing filters or loosely pattern-matches, so a regression surfaces as a specific failed expectation
(charter I9).

1. `GET /api/health` — `ok`, and `projectDir` is the demo project.
2. `GET /api/graph` — exactly 3 entities named `account`/`contact`/`opportunity`, 0 relationships, 4 edges, and **no**
   `contact → opportunity` edge.
3. `GET /api/files` — lists `entities/contact.yaml` with `kind: 'entity'`, `name: 'contact'`.
4. `GET /api/files/entities%2Fcontact.yaml` — content equals the file on disk.
5. `PUT` the same path with `contact.title.type` corrupted from `string` to `strng` → **422**, carrying an issue at
   exactly `['fields','title','type']` with `code: 'invalid_enum_value'` and a message naming `received 'strng'`.
6. The file on disk is **unchanged** — a rejected write must not persist.
7. The *same valid content* `PUT` with `Origin: https://evil.example` → **403**, and the file is still untouched.
   Every other request in the harness carries the server's own origin, as a browser would: the guard allows a
   request with no `Origin` at all (a non-browser client cannot be the CSRF victim it defends against), so a
   harness that sent none would exercise a different path than the UI and stay green through a regression that
   refused same-origin writes.
8. `PUT` the corrected content → 200, and the file is restored.
9. `POST /api/relationships` `{from:'contact', to:'opportunity', kind:'many_to_many'}` → preview is exactly one file,
   `relationships/contact_opportunity.yaml`, whose YAML declares `relationship.name/from/to`; and **nothing is on
   disk** — the dry run wrote nothing.
10. `PUT /api/relationships`, same body → `written` is exactly that one path, and the file exists.
11. `POST /api/generate {steps:['generate']}` → a `runId`; the SSE stream is consumed to its `done` frame (120s
    timeout — a hung stream fails the gate rather than hanging CI), `ok: true`, with a `step` frame for `generate`
    at status `ok`.
12. The run's diff carries `relationships/contact_opportunity.yaml` **and**
    `src/modules/contact-opportunities/contact-opportunity.entity.ts`, each with a non-empty patch.
13. `GET /api/graph` — 5 edges; the new one is exactly `contact → opportunity`, `cardinality: 'N:M'`, named
    `contact_opportunity`; and `graph.relationshipDefinitions.contact_opportunity` carries `table:
    'contact_opportunities'`, `fromColumn: 'contact_id'`, `toColumn: 'opportunity_id'`.

**Kebab and snake in the same list is not an inconsistency** (#710, which now sits below this branch). The rule is
*the filesystem is kebab-case, the database is snake_case, and a YAML name is neither* — so the emitted module is
`src/modules/contact-opportunities/contact-opportunity.entity.ts`, while the relationship is still named
`contact_opportunity`, its definition still lives at `relationships/contact_opportunity.yaml`, and its junction
table is still `contact_opportunities`. The e2e asserts all four spellings, which is what makes it a check on the
rule rather than on a string: a rename that over-applied kebab to the table or the YAML name would fail it.

### 6.3 What it does not prove

**The generated code is never compiled.** The demo project installs no peer dependencies and nothing runs `tsc` over
it. This is a deliberate trade: generation itself needs no peer deps, so the harness costs seconds rather than the
minutes a scaffold-and-typecheck smoke costs, and `just test-smoke` already owns "the generated tree compiles". This
harness owns "the Studio loop works". Stated here so nobody later reads a green `just test-studio` as a compile gate.

It also drives the **HTTP surface, not the browser**. No pane is clicked; the UI's own unit tests
(`tools/studio/src/__tests__`, the graph→xyflow adapter and the Zod-issue→editor-line mapper) run in the same recipe.
Nothing in CI asserts that the rendered panes work — see §7.1.

The panes *were* driven manually once, on 2026-09-20, to write `.ai-docs/studio/README.md` from what renders rather
than from intent: graph, filter, legend, the Detail/YAML/Relate tabs, and the option-pruning behaviour §5 claims.
That check found one defect the HTTP gate structurally cannot catch: `just studio` started Vite with no `--host`, so
Vite bound `[::1]` while the server proxied to `127.0.0.1`, and the recipe served an error page instead of the UI.
Fixed by pinning `--host 127.0.0.1` on the Vite invocation — the address the server dials — rather than teaching the
proxy to guess between `::1` and `127.0.0.1`.

The **proxy contract** it made suspect is now gated, in `just test-unit` and without needing Vite
(`src/__tests__/studio/server-routing.test.ts`, 8 tests): `/api` handled locally rather than forwarded and an unknown
`/api` route 404ing as JSON instead of being swallowed by the SPA fallback; assets forwarded with their querystring
intact; CORS and preflight for the dev origin; static serving refusing to escape the UI directory; the loopback-only
bind; and an unreachable upstream reported as a 502 **naming the origin it dialled** — without which a bind mismatch
is invisible, which is why this one took hand-debugging to find.

That narrows §7.1 without closing it. A test that stands up a fake upstream is not a test that Vite starts, and
nothing still renders a pane. The lesson generalises past this bug: a hand-check that cannot run again is not a gate,
whichever level it is performed at.

### 6.4 Parallel safety

The harness sets `TMPDIR` to a private `mkdtemp` **before** anything spawns the CLI. The CLI reaches hygen through a
bare `bunx` whose cache is machine-wide (#691), so two concurrent gates can read each other's half-written cache.
Setting it inside the harness rather than asking the caller to remember makes `just test-studio` parallel-safe however
it is invoked. `KEEP_STUDIO_DIR=1` preserves the project; a failure preserves it regardless and prints the path.

---

## 7. Open questions the build surfaced

1. **Nothing in CI renders a pane.** `just test-studio` proves the HTTP loop and the UI's pure units, but no gate
   opens the app. A server contract change that breaks the graph pane's layout passes every gate. Options: a
   Playwright smoke that loads the app and asserts three nodes and one edge render, or accept it and say so. The
   repo's rule (CLAUDE.md § Adding a gate) is that a gate running nowhere rots — this is the inverse, a surface with
   no gate at all.
2. **`POST /api/validate` is in the contract but nothing drives it.** The editor validates through `PUT /api/files`,
   which validates one file; the whole-project validate is unexercised by the e2e and, as far as this spec knows, by
   the UI. Either the UI should surface it (a project-level error banner is the obvious use) or it should be deleted
   per I7 rather than kept as an unused route.
3. **`restart` has nothing to restart, and `dbPush` works but no gate covers it.** `RunStepName` names three steps.
   `generate` is gated by the e2e. The other two were verified by hand against `just studio-demo` on 2026-09-20 and
   the results differ:
   - **`dbPush` works end to end**, against a demo built with `just studio-demo-db`.
     `{"steps":["generate","dbPush"]}` ran `bunx --no-install drizzle-kit push`, reported `Changes applied`, and
     left `accounts` / `contacts` / `opportunities` in the demo's Postgres. The database comes from
     `materializeDemoProject`'s optional `databaseUrl` (writing `drizzle.config.ts` + `.env` and installing pinned
     drizzle-kit/orm), derived from `test/scaffold/harness-env.ts` — never a second derivation. The plain
     `just studio-demo` leaves it unset and needs no Docker, which is why the two are separate recipes rather than
     one recipe with a flag: the documented path cannot silently reacquire a Docker dependency. That file is **not on `main`**: it arrives via #615's harness commits (`3100de2`, `c3d1514`),
     cherry-picked onto the Studio server branch for parallel-gate safety and labelled there as dropping out when
     #615 merges. Whichever of the two merges first supplies it.
   - **`restart` runs and reports `ok`, but the thing it restarts does not exist.** It shells `codegen dev restart`,
     which warns `app restarted (PID …) but not responding yet` — the demo installs drizzle only, no NestJS
     packages, so there is no server to bring up. The step is wired; the demo is not a runnable app.

   Neither is gated. The e2e leaves `databaseUrl` unset on purpose so `just test-studio` stays Docker-free and
   seconds-long; gating `dbPush` means accepting Docker in that gate or giving it its own CI job, the way
   `just test-integration` has one. That is the decision to make, not "wire it up".
4. **One run at a time is enforced with a 409, but nothing recovers a wedged run.** If a run's subprocess hangs, the
   registry stays occupied and every later Generate is a 409 until the server restarts. A timeout or a cancel route
   is the obvious fix; neither is built.
5. **The relationship form cannot express every relationship the YAML can.** `RelationshipOptions` covers `name`,
   `inverse`, `through`, `required`, `onDelete`, and `many_to_many`'s `types`/`temporal`/`sourced`. A relationship
   definition's `fields:`, `queries:`, `uniqueOn` and per-endpoint `on_delete_from`/`on_delete_to` are not reachable
   from the form — they need the editor pane. That is a reasonable slice-1 line, but it means the form is a starting
   point for a relationship, not a full editor for one, and the UI should say so rather than imply completeness.
6. **The demo cannot show a `role` edge — the one graph edge kind no real graph here confirms** (#709). Studio
   renders role edges as their own kind (`classifyEdge` reads `edge.relationship.role`, which this stack added to
   `serializeDomainGraph`), and the path is typed and unit-tested, but no demo entity declares `roles:`, so nothing
   exercises it on a real graph. It is not a fixture edit: `roles:` requires `Communication` on the declaring entity
   and `Actor` on the target, so it needs a fourth demo entity, and the capability mixins resolve through
   `@shared/*`, which the demo's package runtime mode does not provide — that last constraint decides the cost and
   should be checked first. A role also derives a `belongs_to`, so `EXPECTED_EDGES_BEFORE` / `EXPECTED_EDGES_AFTER`
   in the e2e move with it. This matters beyond tidiness: roles are the headline of #578, so the demo currently
   cannot show the thing it most exists to demonstrate.

7. **The demo project resets on every `just studio-demo`, and that is now the documented contract.** The recipe
   passes `--clean`, so a re-run discards whatever was in `.studio-demo/`. Fine for a demo, surprising if someone
   leaves real work there, so the README says so outright. `.studio-demo/` is gitignored alongside the recipe that
   creates it — `just studio-demo` writes it into the repo root, and a `git add -A` would otherwise commit a whole
   generated project. What is still undefined is when it should be refreshed against a changed demo entity set.

---

## 8. File ownership

Built by three agents in one stack; recorded because the boundaries explain the shape of the code.

| Area | Owner |
|---|---|
| `src/studio/shared/api.ts` — the wire contract | server |
| `src/studio/server/**` — HTTP surface, CLI shelling, run registry, diff | server |
| `src/studio/demo/**` — demo entity set + `materializeDemoProject` | server |
| `just studio`, `just studio-demo` | server |
| `tools/studio/**` — Vite app, panes, graph canvas, kind registries | ui |
| `just test-studio` + its `test-all` line | ui |
| `docs/specs/STUDIO-0.md` (this file) | demo |
| `test/studio/**` — the end-to-end harness | demo |
| `.ai-docs/studio/README.md` — how the owner runs it | demo |

The demo fixture lives under `src/studio/demo/` rather than `test/studio/` for a stack reason: the demo PR sits
**above** the server PR, and a base PR cannot import from a branch above it. Putting the fixture in the server's PR
lets `just studio-demo` work standalone at that point in the stack, and the e2e imports down into it.

---

## 9. Charter invariants this touches

- **I1 declare once.** The Studio never introspects generated output to recover what the YAML says. The graph comes
  from the analyzer over the YAML; the diff comes from git. The relationship form's request is `{from, to, kind}` —
  intent — and the YAML remains the single declaration.
- **I7 no backwards compatibility.** The Studio is new surface; nothing was kept for compatibility. `project graph`'s
  existing "write a temp file and tell the user to run vite preview" path is untouched by this spec but is now the
  lesser of two viewers — if the Studio subsumes it, ARCH-0's precedent says delete it rather than keep both. Filed as
  a question, not done here.
- **I9 gates are honest.** `just test-studio` filters nothing. §6.3 states plainly what it does not cover rather than
  letting a green gate imply more than it proves, and §7.1 records the untested surface as an open question instead of
  a quiet gap.
- **I10 public repository.** The demo set is a generic CRM shape — account, contact, opportunity. Nothing in it or in
  the Studio refers to a host application.
- **I11 scope discipline.** No change to the backend pipeline, no consumer-application change. The server adds one
  serializer fix (`role` now reaches `SerializedRelationship`, which the edge copy had been dropping); everything else
  is new surface.
