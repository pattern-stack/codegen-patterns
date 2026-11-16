# Handoff: codegen-patterns-7f (lead: ADR-046 + Studio), 2026-11-16

This session was the **lead** for ADR-046 ("derived once; templates print it") and the Studio canvas and API work. Doug
decides. The lead reviews orchestrator output, verifies claims against code, relays decisions and merges on Doug's word.
It does not build. The session closed with all agents stopped. Pick up from here in a new session.

## Shipped (main, released as 0.34.0 on npm, #928)
- ADR-046 Phase A (#876–#887) and Phase B (#888, #895–#898): the derivation in `src/derived/api/`, templates print
  from it, `codegen project surface`, and Studio's API tab and edge view.
- STUDIO-3 (#891, tree canvas) and STUDIO-4 (#900: rows wrap to the viewport, one-card parent trees dock under
  their referencer, the inspector can be hidden, the legend-aware fit).
- #875 joined-table inheritance (#907–#912), owned by the other lead `codegen-patterns-73`.
- Fixes: #918, #919, #923, #924, #926 (`globalThis.*` in the emitted backend). #929 (API-tab long origin chip) is
  merged after 0.34.0.

## Merged at close
- **#933 STUDIO-5** (main 366b8301): dbt-style selectors `a+`, `+a`, `N+a+M`. Space or comma means union, which
  diverges from dbt, where a comma is an intersection. Double-click focuses `1+name+1`, and the subset is re-laid
  out. Junctions are crossed both ways (D2, Doug). One owner for the text match (`matchesGraphQuery`).
- **#934 STUDIO-6** (main b04f1a8a): the spine-order toggle (Inheritance first by default / Ownership first) and
  the floating "is a <Base>" chip, kept by Doug's decision. A base chip appears only when its base card is in the
  selected subset.
- All agents are stopped. No Studio is running.

## Approved, not started (do next)
1. **FK rows on cards (dbdiagram-style)** = **ADR-046 slice 2's first piece** (#892). Two PRs, stacked:
   (a) derive each entity's columns once in `src/derived/columns/` (belongs_to FK columns, the inherited id, the
   columns `match:` derives, the tenant column, each with its source) and serve them in `/api/graph`
   (`src/analyzer/serialize-graph.ts`, `src/studio/shared/api.ts`); (b) Studio: show those rows on the cards, set
   apart from declared fields; land each line on its FK row and on the referenced column; never collapse a row a
   line lands on. Screenshots go to Doug before merge. Fold serialize-graph's `fkUnique` duplicate (#892) into the
   same owner. Plan notes: `.ai-docs/stacks/api-surface-model/SLICE2-FK-ROWS.md` (if the orchestrator wrote it).
2. **S7 (#917): Integrated on a joined-table child**, owned by `codegen-patterns-73`. CP2 is passed. Doug approved
   S7-D6 = (A) (a child's sync emits only child-named events) and asked for S7a–c to be pushed as draft PRs. Next:
   S7d (the Docker integration-tier sync test and the smoke family), then Gate 2.5 reviews, then CP3. See that lead's
   handoff under `.ai-docs/stacks/integrated-child-917/`.
3. **#930: refuse** a NOT NULL, no-default column in `integration.sink.exclude_fields` at validation (approved).
4. **Rename the inheritance test fixtures** (`test/fixtures/inheritance/`: communication / email / meeting /
   email_thread / participant / transcript) to unrelated generic names. They mirror a private model's shape
   (approved).
5. Follow-ups, queued and not approved to start: #893 (print the "Inherited from" comments from the derivation),
   #894 (class names into the derivation plus a lint), #925 (+ comment: `entity validate` must run generation's
   checks, including the 63-byte identifier check that lives in entity-locals.js:1118), #920, #921, #922, #927,
   #931, #932.

## Open, not yet raised to a decision
- npm warned at publish that tokens bypassing 2FA are being restricted (gh.io/npm-gat-bypass2fa-deprecation). CI
  publishing may break. Offer an issue to move to npm trusted publishing (OIDC).
- Public main already carries private host names in older docs (`.ai-docs/handoff.md` history and
  `.ai-docs/plans/codegen-app-patterns.yaml`). Raise it with Doug: scrub them, and consider history.

## Rules this lead held
- Public repo: no host-app names, paths or shapes in code, PRs, issues or committed docs. Leak checks use
  `$PRIVATE_NAMES_RE`, which the lead supplies and which is never written into the repo.
- Doug merges, or says "merge"/"yes to all". Never auto-merge. Stacks land atomically (`gh stack merge`).
- Ask Doug in the terminal, with a recommendation. "Yes to all" lists work well. He judges UI by screenshots or a
  live Studio. Run review Studios on the SERVER port and check `/api/health` for projectDir.
- Take Studio asks only through the lead; another session relaying "Doug wants" needs Doug's confirmation.
- Worker agents run in Herdr lanes. Orchestrators run out of context. When one does, compact it with
  `hc keys <t> / c o m p a c t enter`, then re-prime it from its handoff.
