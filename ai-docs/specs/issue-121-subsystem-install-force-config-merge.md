# Issue #121 (F13) — `subsystem install --force` preserves config; `--force-config` for opt-in clobber

## Problem

`codegen subsystem install <name> --force` re-runs the Hygen scaffold including the `codegen-config-<name>-block.ejs.t` template that injects the `jobs:` / `events:` block into `codegen.config.yaml`. The template's `skip_if` regex is a defensive check, not an authoritative gate — in TEST-SESSION-1 Phase B the block got clobbered, silently resetting `multi_tenant: false` back to the template default. That cascaded into a dropped `tenant_id` column on the next `drizzle-kit push`.

Same anti-pattern class as #119 (F11): unconditional inject steps with no CLI-side detection.

## Design — skip-with-info by default, opt-in overwrite

Option (c) from the architect analysis. Two clean modes; no YAML merge.

- **Default (`--force` alone):** if the target block is already present in `codegen.config.yaml`, the CLI logs an info message and SKIPS the config-block template. Other scaffold steps (runtime copy, schema template, etc.) proceed. User config is preserved.
- **`--force-config`:** new independent flag. When set, the config-block template runs with Hygen's `--force` so it overrides `skip_if` and overwrites the block. Intentional regeneration path.
- **Combined:** `--force --force-config` is today's old clobber behavior — now explicit and opt-in.
- **Parse error in codegen.config.yaml:** non-zero exit with a clear error. Refuse to inject rather than silently overwrite.

Not merging. Merging with `yaml@2` round-trip risks comment/anchor loss in the jobs `pools` section and would be a forever-tax on template authors. Two clean modes beats one fuzzy merge.

## Detection

`src/cli/shared/config-block-detect.ts` — pure `detectConfigBlock(yamlSource, subsystem) → 'missing' | 'present' | 'parse-error'`. YAML parse via the existing `yaml` dep; top-level key lookup only. Unit-tested with: missing, various present shapes (null/empty-map/full), commented-out lines, malformed YAML, block-name-as-string-value-in-another-key.

## Subsystems affected

Only `jobs` and `events`. `cache`/`storage` have no scaffold today. The helper accepts all four names for forward compatibility; only two wire points exist currently (`runJobsScaffold`, `runEventsScaffold`).

## Test strategy

- Pure unit tests for the detector in `src/__tests__/cli/config-block-detect.test.ts`.
- Integration tests extending `src/__tests__/cli/subsystem.test.ts` using the existing `mkTempProject` harness: preservation under `--force`, overwrite under `--force --force-config`, parse-error path.

## Why not template-side guard

Hygen's `skip_if` is a regex over the target file's content and is still present in the templates as a second line of defense. The authoritative gate is CLI-side because:
- Regexes over YAML have structural false positives (commented-out lines, string values).
- The CLI-side gate lets us emit a clean user-facing info message, which the template cannot.
- The detector is unit-testable without invoking Hygen.

## Docs updated

- `docs/specs/TEST-SESSION-1.md` — F13 marked resolved (2026-04-20).
- `.claude/skills/{jobs,events}/SKILL.md` — if they reference `--force` semantics, updated in the same PR.
- `docs/adrs/ADR-008-subsystem-architecture.md` — revision note on install flag matrix if relevant.
