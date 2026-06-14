# Handoff — Sync-Job Primitives (A) → codegen jobs-definition-kind (B)

**Session:** 2026-06-13/14. **Author:** Claude (codegen-patterns session).
**Status:** design grounded + locked; **no implementation started by me.**

## TL;DR verified state (re-swept 2026-06-14, both repos, all refs + PRs + worktrees)
- **Part B (codegen jobs-definition-kind): does not exist anywhere.** Pickaxe across all
  branches + full history for `JobDefinitionSchema` / `definitions/jobs` / `loadJobs` /
  `job-handler-emission` = **zero**. No branch, no PR. **Never started.**
- **Part A (swe-brain primitives): ~60% done, UNCOMMITTED WIP, a day stale.** Lives only in
  the `velvet-snuggling-yeti` worktree as untracked `apps/backend/src/jobs/sync/` +
  3 modified handlers. Not on any ref. **At risk** — see the velvet handoff note.
- **ADR-0018:** referenced in the Part-A code comments everywhere, but **the doc does not exist.**

## Artifacts produced this session (saved, untracked)
- `.ai-docs/research/jobs-kind-design-brief.md` — the full design brief: anchor verification
  (28/31 confirmed, HIGH confidence), resolved D1–D5, the proposed `JobDefinitionSchema`,
  PR-sized work breakdown, ADR-0018 outline, risks. **This is the live plan.**
- `.ai-docs/research/jobs-kind-grounding.workflow.js` — the 10-agent grounding workflow
  (re-runnable / resumable).
- `.ai-docs/requests/job-primitives-and-codegen-jobs-kind.md` (in the velvet worktree) — the
  original request that kicked this off.

## Decisions LOCKED with Doug this session (override the brief where noted)
- **Cadence = owned by the JOB** (overrides the brief's D4 "event-owned" recommendation).
  Doug: "job declares its own cadence; I'm not setting up timers then attaching jobs."
  The in-flight Part A already implements exactly this (`SyncJobProfile.cadence: '1h'` +
  `realizedBy: <event>` + a drift-guard; Part B's emitter later generates the event FROM
  `cadence` and `realizedBy` drops). Firing mechanism stays "app-level, align thereafter."
- **Realtime = NOT a peer primitive** (D1 confirmed). It's the existing `webhook` change-source
  mode + a claim/ack drain loop in the handler. Part A defers it entirely to a future
  `realtime-drain.ts`; `inbound-sync` is untouched. `kind: realtime` stays a schema label only.
- **`differOverride` = DEFER** (D2). Global `differ.unignore` + per-entity DI rebind suffice.
- **Local `(provider,domain)→use-case` registry now; codegen #458 is NOT a B blocker** (D5).
- **Piggyback A into B** (Doug): design the YAML directly for B; swe-brain is the first
  consumer. Drops the throwaway "hand-build 3 generic primitives then delete" phase. Behaviour
  oracle is still *today's* 4 handlers.

## OPEN question Doug did NOT resolve (resolve before Part B schema freeze)
**Cadence shape: single-string vs trigger-list.** Part A models cadence as one
`cadence: '1h'` string per job — clean for the 3 heal jobs, but the grounding found
`inbound-sync` has **zero** cadence and `drive-poll` has **cadence + a webhook doorbell**.
Recommended resolution (mine): model `triggers` as a **list** with a `schedule` arm + an
`event` arm (Doug's own "ScheduleTrigger" idea), with a single `cadence` as sugar over one
schedule-trigger. Handles 0/1/N without a special case. Surface this in ADR-0018.

## Next actions (ordered)
**Part B (codegen — this repo), per the brief §4:**
1. Write **ADR-0018** (or its codegen-side spec) locking the schema on paper — the A↔B byte
   contract. Fold in cadence-on-job + the trigger-list resolution above.
2. `src/schema/job-definition.schema.ts` — fresh Zod schema; imports `DetectionConfig`
   per-arm (do NOT modify detection-config; fix its stale `:17` "four shapes" header in the
   same PR). Two discriminated unions at two altitudes: arm-`kind` (poll|reconcile|realtime)
   over source-`mode` (poll|webhook). Surface all 8 `JobHandlerMeta` fields.
3. `src/parser/load-jobs.ts` + `detectYamlType` 'jobs' branch (`yaml-loader.ts` ~526-547).
4. `src/cli/shared/job-handler-emission-generator.ts` — seam-split emitter (`@generated` base
   + emit-once subclass), mirroring `sink-emission-generator.ts`. Wire a `jobs` post-step in
   `src/cli/commands/entity.ts`.
5. `just test-smoke-integration` MUST tsc-compile the emitted tree (project gate).
6. 🚦 RELEASE GATE: merging codegen `main` auto-publishes to npm (immutable). Run
   `just test-post-publish` first. swe-brain's B-dogfood consumes the *published* tarball.

**Part A (swe-brain — the velvet agent):** finish 3 remaining profiles
(`drive-poll`/`reconcile-poll`/`inbound-sync`), the realtime-drain shape, ADR-0018, and
**commit the WIP first** (see velvet note).

## Key risks
- **At-risk WIP** — Part A is uncommitted in a worktree, a day stale. Commit/branch before anything else.
- **npm auto-deploy coupling** — the one hard cross-repo serialization point (B publish → A regen).
- **Behaviour parity** — baseline today's 4 handlers (esp. `cursorWithheld` on reconcile arms;
  a regressed watermark silently re-processes) before the B-lift.
- **Emitter/AST-seam coexistence** — generated handler skeleton vs the bridge-registry
  generator's AST scan of authored `@JobHandler` in `<backend>/jobs`. Don't break the bridge harvest.
