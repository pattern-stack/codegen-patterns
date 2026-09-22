# Handoff — 2026-09-22 — relations-v2 + semantic model shipped

**Branch:** `main` @ `13e5425a`. Working tree clean. No project work in flight.
**Last action:** project #578 (relations-v2 + semantic model) merged in full — 25 stacked PRs plus #713 (REL-2), which was rebased onto the merged `main` and landed clean.
**Next action:** the **#679 design discussion** — converge `pattern: Junction` and `relationship:` into one association concept. The owner's stated first item, and REL-2's own code comments defer to it twice.

---

## State

Everything for #578 is merged. Only three unrelated, long-stale PRs remain: **#271** (post-publish smoke), **#550** (BullMQ jobs/events), **#556** (frontend-exclude-entities). Each needs a decision to revive or close.

`main` is green — `just test-all` and `just test-integration` both pass at `13e5425a` (integration is 160 tests; REL-2's leak suite added 23).

### A release is pending, and it is breaking

`package.json` says **0.30.0**, and **0.30.0 is what npm has** — but `main` now carries five breaking changes on top of it:

| Commit | Change |
|---|---|
| `b0fffeb0` | CAP-1 — `kind:'capability'` + composed-base emission |
| `d1892b2c` | ARCH-0 — the `clean` backend pipeline deleted |
| `0ef309ff` | ARCH-1 — the clean-only config surface deleted |
| `411deb25` | NAME-2 — clean-lite-ps renamed `backend`; emitted files kebab-cased |
| `13e5425a` | REL-2 — `BaseRepository` and every family base take a third, **required** type parameter |

No consumer can reach any of it until a bump lands. `just bump minor` → merge to `main` publishes automatically (CI `publish` job). 0.x, so breaking → minor; the owner's call.

Consumers waiting:
- **sdlc-patterns** pins `@pattern-stack/codegen` **0.26.1**. Bump both pins, `bun pm cache rm`, install, regen, both biome scopes.
- **swe-brain** — its Postgres container is still up (`swe-brain-postgres-1`); pin unverified from here.

## Open, recorded rather than lost

- **#679** — junction/relationship convergence. Blocks REL-3 and FE-REL. REL-2 left two explicit deferrals: a relationship table has no typed `with` because per-type edges need the `types:` enum threaded into the manifest, and a junction-only entity gets no typed include, "which loses a feature rather than breaking a build".
- **#726** — *gates that cannot fail on their own subject*. Filed this session; four variants found in one night. CLAUDE.md's testing section gained the matching rule.
- **#709** — the `role` edge kind is the one edge kind no real graph confirms. Matters because roles are #578's headline, not a tidy-up.
- **STUDIO-0 §7.1** — nothing in CI renders a pane. The Vite bind bug is the concrete evidence the gap is real.
- **#717** — Studio entity lens. Design canvas: https://claude.ai/artifact/KenJgcCzbPKhhpfL8a7aMW

## What this session fixed

Thirteen defects; eleven were one shape — **a PR changed a contract and left a harness, assertion, config, or emitter writing the old one.** Three were PRs failing their *own* newly-added gate. `main` was green throughout: these only bite in combination, which is why a 25-deep stack surfaced them together.

Two worth remembering by name:

- `test/smoke/run-smoke-junction.ts` **did not parse**, so `test-smoke-junction` had never executed on eleven PRs. Eleven identical reds read as one inherited upstream problem and were dismissed for days.
- ARCH-1 replaced a `...locals` spread with an explicit key list and dropped `ownedTableNames`. It was still computed and still returned, so nothing read as deleted — it simply stopped arriving, and an absent set means *"every target is owned"*, silently reverting #636. The same hazard recurred in the REL-2 rebase a day later (`generatedDir`), which is why it is now a CLAUDE.md rule.

## Operating notes

**Verify by content, never by identifier.** Three identifiers gave false alarms this session: blob hashes (a transcription slip in prose while the recorded file was right), SHAs (`--is-ancestor` goes false after any rebase — it answers "is this exact object in my history", not "is this change in my tree"), and commit subjects (this repo **squash-merges**, so a branch's subjects never appear on `main` by construction and its tip is correctly *not* an ancestor). Only `git diff <tip> origin/main -- <paths>` answers "did my work land".

**Verification tooling deserves the same suspicion as the thing it verifies.** A CI monitor here reported 23/23 green when GitHub had not yet created any check runs — it read empty as settled. Require each job to report an actual bucket; treat missing *and* pending as unsettled. Relatedly `mergeable` only means "no conflicts" — **`mergeStateStatus`** (`CLEAN` / `UNSTABLE` / `BLOCKED`) is the field that reflects checks.

**Multi-session cascades:** when a cascade moves sibling branches, broadcast the new SHAs to **every** session whose branch moved, not just the next driver. The cost of not doing so is not idle waiting — it is an agent running gates against a tip that no longer exists and reporting green for a tree nobody will merge.

Restacking specifics live in `~/.claude/projects/-root-codegen-patterns/memory/restack-with-gh-stack.md` — the stale `.git/gh-stack` cache, the unstack→link→re-import dance for restructuring, the squash-merge fork point, and the three ways `gh stack` mis-reports.

## Workspace

Cleaned at the end of this session: the main checkout moved off the merged `chore/release-0.30.0` back to `main`; the stale `worktrees/*` removed (all four peer sessions confirmed clean and stood down); local branches for merged PRs pruned. **Origin keeps all `dugshub/*` branches** — this repo does not delete on merge, and that convention was left alone.

`.ai-docs/stacks/relations-v2-and-semantic-model/ORCHESTRATOR-HANDOFF.md` (untracked, 2026-09-18) was removed: an operational snapshot for dispatching work now merged, and iterative snapshots are disposable. The durable docs — `PROJECT.md` (the charter) and `PLAN.md` — are tracked and stay.
