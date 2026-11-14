# Revision 1 — fold in the lead's review, and make the plan runnable by one long orchestration session

Same rules as LANE.md: read-only on source, write only inside `.ai-docs/stacks/api-surface-model/`, no branches,
commits, issues, PRs or sub-agents. Report with `SendMessage` to `codegen-patterns-7f` (hc terminal `t1hz`).

## Doug's decisions (2026-11-12)

He approved the plan with the lead's four changes, and answered the open questions:

- **Q1 yes, and Phase B is committed when Phase A is.** The gated duplicate is temporary by decision, not by hope.
- **Q2 yes** (shell `project surface --json`). **Q3 yes** (`unmodelled`, #679). **Q6 yes** (record oddities, don't fix).
- **B4 does NOT wait for REL-3.** B4 moves names/existence into the model; REL-3 later rewrites bodies and edits a
  model entry. Update §10, R5 and the PR table accordingly.
- **Rename `src/model/`** — "model" collides with the charter's *semantic model* (ADR-045, `AggregateModel`).
  Use `src/surface/api/` (slices 2/3 → `src/surface/columns/`, `src/surface/wiring/`) unless you find a concrete
  reason it is worse; if so, say so and propose one name.
- **No param/return *types* in A1.** Names, kinds, provenance, param *names*, shape (`one|many|count|projection`)
  only. Do not move the field-type function; types arrive with slice 2. Re-size A1.
- **A2 is ~1 day**, not 0.5 (whole-set pass, pairing/`inverseOf`, F7 warning, new verb). Re-total Phase A.
- READ-1 is being merged now. Re-cite against `main` once it lands if line numbers move; until then keep the
  `e9fe6f5f` citations and say so.

## The main new ask: testing conditions strong enough to run unattended

Doug wants to run Phase A + B as **one long orchestration session** (a lead agent working the PRs in order, building
lanes at medium effort), checking in only to sign off. That only works if every step has exit criteria an agent can
verify by itself and cannot satisfy by weakening a test. Add a new section **§14 Execution protocol** with:

1. **Per-PR exit criteria** — for A0…B4, a checklist of exact commands and exact expected results
   (e.g. `just test-baseline` exit 0 **and** `git diff --stat test/baseline` empty; parity gate green; named
   mutation checks each red then reverted, with the exact mutation and the exact failure text expected). Each item
   must be checkable from command output alone. No "looks right".
2. **Anti-cheat rules** — what the orchestrator may never do to get green: edit a snapshot to match without the PR
   being one that intends snapshot changes (Phase B never does); add to the lint allowlist (it only shrinks);
   loosen/skip an assertion; add a predicate to `_consumer-errors.ts`; mark a test `.skip`/`.todo`; widen a parity
   comparison. Say how each would be detected in review (e.g. `git diff` on the allowlist file must be deletions only).
3. **Pre-flight on F7.** Before A2 is specified as a warning, confirm F7 by actually running it: a scratch copy of
   a fixture with a `has_many` onto a plain-field FK, generate, typecheck — record the exact error. Do this now if you
   can within your read-only rules using a scratch dir outside the repo (e.g. `$TMPDIR`); otherwise make it the
   first step of A2's protocol.
4. **Sign-off checkpoints** — where the orchestrator stops and waits for Doug. Propose the minimum set; the lead's
   suggestion: (S1) after A1 — the model's shape and parity gate, before anything consumes it; (S2) after A4 — the API
   tab in the browser; (S3) after B1 — the goldens, before any template edit; (S4) after B4 — final, before the
   batch lands. For each: what Doug looks at (artifact, screenshots, a 1-page diff summary) and what "approve" unlocks.
5. **Stop conditions** — when the orchestrator must halt and ask rather than push on: a byte diff it cannot explain
   in one sentence; a design decision not covered by the plan/ADR; READ-1 or REL-3 landing changes under it; any
   gate it would have to change to pass; two failed fix attempts on the same gate.
6. **Evidence each PR body must carry** — gate outputs from the run after the last edit (charter I9), the mutation
   checks with their red output, the silent-drop reader list for every deleted local (§5).
7. **Landing** — Phase A and Phase B each land as one gh stack with atomic merge; no auto-merge (Doug merges).

Keep it tight: tables and checklists, not prose. Update the §1 summary (sizes, decisions now resolved) so the first
screen is still true. Report back when done: one paragraph, plus the F7 result.
