# Issue #120 (F12) — entity new --all tolerates bad YAMLs

## Problem

`codegen entity new --all` short-circuits on the first invalid YAML, skipping all valid entities in the batch. Surfaced in TEST-SESSION-1 Phase A: the scaffold-generated `entities/example.yaml` (comments only, no `entity:` key) wedges subsequent generation even though every other file in `entities/` is valid.

Three gates in `src/cli/commands/entity.ts` (pre-flight validation, cross-validation, Hygen loop break) all condition on `!this.continueOnError` with `continueOnError` defaulting to `false`.

## Fix

Two-commit, two-pronged:

1. **Flip the default.** `Option.Boolean('--continue-on-error', true)`. The flag name stays; Clipanion's auto-generated `--no-continue-on-error` restores strict behavior for users who want it. Update the inline help/comment.
2. **Stop seeding a broken placeholder.** `project init` in `src/cli/shared/init-scaffold.ts` skips creating `entities/example.yaml` when the `entities/` directory already contains another `*.yaml`. Defense in depth — even if a user passes `--no-continue-on-error`, a real project won't get the broken stub.

## Why both

The default flip alone fixes the reported bug, but leaves the latent issue that a fresh `project init --force` on a populated repo will re-drop the broken placeholder (see also #119's anti-pattern class). The init-side guard addresses the root cause. Either commit can be reverted independently.

## Tests

- `src/__tests__/cli/entity.test.ts` — two new cases on the existing `mkTempProject` harness:
  - `--all` with one valid + one invalid YAML now exits `0` and reports both.
  - `--all --no-continue-on-error` restores exit `1`.
- `init-scaffold.ts` — no new test (existing harness doesn't cover that branch; not worth a new harness for 4 LOC of guard logic).

## Docs updated

- `docs/specs/TEST-SESSION-1.md` — F12 marked resolved (2026-04-20).
- `.claude/specs/cli-02-entity-noun.md` if it mentions the flag.
