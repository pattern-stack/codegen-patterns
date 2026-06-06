# codegen-patterns justfile
# Run `just` to see all available recipes

set dotenv-load := false

# ─── Dev ──────────────────────────────────────────────────────────────────────

# Install all dependencies
install:
    bun install
    cd test/scaffold && bun install

# Generate a single entity from YAML (new noun-verb CLI)
gen entity:
    bun src/cli/index.ts entity new {{entity}}

# Generate all entities (new noun-verb CLI)
gen-all:
    bun src/cli/index.ts entity new --all

# Scan a project and generate config
scan path=".":
    bun codegen scan {{path}}

# Scaffold a subsystem (events, jobs, cache, storage) via the new CLI
gen-subsystem name:
    bun src/cli/index.ts subsystem install {{name}}

# ─── Test ─────────────────────────────────────────────────────────────────────

# Run unit tests (base classes + subsystems + scanner + schema).
# Paths are anchored via justfile_directory(): `bun test <path>` treats the
# arg as a SUBSTRING filter, so a relative `src/__tests__/` also matches any
# checkout under worktrees/<x>/src/__tests__/ and runs its stale tests.
test-unit:
    bun test "{{justfile_directory()}}/src/__tests__/"

# Run end-to-end smoke test: scaffold + generate + typecheck a fresh project.
# Completes in ~60-120s. Set KEEP_SMOKE_DIR=1 to preserve the tmp project.
test-smoke:
    bun test/smoke/run-smoke.ts

# Junction smoke: intra-domain pairing (opportunity × contact), clean-lite-ps
test-smoke-junction:
    bun test/smoke/run-smoke-junction.ts --scenario junction --architecture clean-lite-ps

# Junction smoke: intra-domain pairing, clean (full Clean Architecture)
test-smoke-junction-clean:
    bun test/smoke/run-smoke-junction.ts --scenario junction --architecture clean

# Junction smoke: cross-domain pairing (opportunity × activity), clean-lite-ps
test-smoke-junction-cross-domain:
    bun test/smoke/run-smoke-junction.ts --scenario junction-cross-domain --architecture clean-lite-ps

# Junction smoke: cross-domain pairing, clean
test-smoke-junction-cross-domain-clean:
    bun test/smoke/run-smoke-junction.ts --scenario junction-cross-domain --architecture clean

# Junction snapshot tests — locks emitted output of junction codegen against drift.
# Regenerate after intentional template changes: bun test --update-snapshots test/junction/
test-junction:
    bun test "{{justfile_directory()}}/test/junction/"

# Integration-emit snapshot (RFC-0001 §7) — locks the emitted src/integrations/**
# tree (provider modules + adapters + barrel + aggregator + types.generated.ts)
# for the checked-in integration-patterns fixture. Regenerate after intentional
# emission changes: bun test --update-snapshots test/integration-emit/
test-integration-emit:
    bun test "{{justfile_directory()}}/test/integration-emit/"

# Refresh the integration-patterns snapshot fixture YAML from a local checkout.
# Manual + reviewed — NEVER auto-synced (RFC-0001 §7). Point at your local
# integration-patterns repo; pass its definitions root via `repo=`:
#   just refresh-integration-fixture repo=../integration-patterns
# Then re-snapshot + review: bun test --update-snapshots test/integration-emit/
refresh-integration-fixture repo="../integration-patterns":
    #!/usr/bin/env bash
    set -euo pipefail
    src="{{repo}}/definitions"
    dst="test/fixtures/integration-patterns/definitions"
    if [ ! -d "$src/entities" ] || [ ! -d "$src/providers" ]; then
        echo "ERROR: expected $src/{entities,providers} — is {{repo}} an integration-patterns checkout with definitions/?"
        exit 1
    fi
    rm -rf "$dst/entities" "$dst/providers"
    mkdir -p "$dst/entities" "$dst/providers"
    cp "$src"/entities/*.y*ml "$dst/entities/" 2>/dev/null || true
    cp "$src"/providers/*.y*ml "$dst/providers/" 2>/dev/null || true
    echo "Refreshed fixture from {{repo}}. Review the diff, then:"
    echo "  bun test --update-snapshots test/integration-emit/"

# Run the relationship-scenario smoke (CGP-62): self-ref + cross-entity
# belongs_to + has_many against the CRM fixture set. Verifies the
# clean-lite-ps Drizzle relations() emission shape. ~60-120s.
test-smoke-relationship:
    bun test/smoke/run-smoke.ts --scenario relationship

# Subsystems smoke (#6 swe-brain-unblock criterion): events + jobs drizzle
# install + full-tree tsc with NO subsystem excludes + no static
# bullmq/ioredis imports in the vendored tree. Locks in the lazy-load +
# filter contract from PRs ce88e17/99673d9/3a5134a. ~60-120s.
test-smoke-subsystems:
    bun test/smoke/run-smoke-subsystems.ts

# Integration-compile smoke — generate the integration tree against the
# checked-in integration-patterns fixture (entities + providers) and run
# `tsc --noEmit`, scoped to src/integrations/**. Closes the smoke-gap:
# integration-emit only asserts string content (never compiles), and the
# default smoke has no provider surface — so nothing in CI ever `tsc`'d the
# emitted src/integrations/** tree. Compiles against the IN-REPO runtime +
# surface sources (the contract under test). ~30-60s. Requires `just install`
# (node_modules/@pattern-stack/ must be linked). Set KEEP_SMOKE_DIR=1 to keep.
test-smoke-integration:
    bun test/smoke-integration/run.ts

# Run baseline test (generate + typecheck + compare to baseline)
test-baseline:
    bun test/run-test.ts full

# Typecheck the clean-pipeline generated output in packages/api/src
# Uses test/tsconfig.baseline.json with runtime/ @shared/* aliases
# (no regeneration — run after test-baseline or just gen-all)
typecheck-baseline:
    bun test/run-test.ts typecheck

# Capture current output as new baseline
baseline:
    bun test/run-test.ts baseline

# Compare gen/ to baseline/ (no regeneration)
compare:
    bun test/run-test.ts compare

# Run family repo integration tests (requires Docker + db-up + db-push)
test-family:
    bun test "{{justfile_directory()}}/test/scaffold/tests/crm-entity-repository.test.ts" "{{justfile_directory()}}/test/scaffold/tests/activity-entity-repository.test.ts" "{{justfile_directory()}}/test/scaffold/tests/metadata-entity-repository.test.ts"

# Tarball smoke (#190): build + pack every publishable package, install the
# tarballs into a fresh tmp project via npm, verify the consumer contract
# (files manifest, exports, bins, peer ranges), then run the FULL consumer
# workflow from the tarball (run-smoke.ts in SMOKE_TARBALL mode: project init
# → entity new → subsystem installs → tsc → /docs-json). Catches the
# works-from-checkout-broken-from-tarball class. Gates `just publish-ci`.
test-post-publish:
    bun test/post-publish/run-tarball-smoke.ts

# Run scaffold integration tests (requires Docker)
test-integration:
    bun test/scaffold/run-integration.ts

# Run integration tests, skip codegen (already generated)
test-integration-quick:
    bun test/scaffold/run-integration.ts --skip-codegen

# OBS-LIST-1 Drizzle read paths against a real Postgres (testcontainers).
# Spins its own ephemeral postgres:16 — no `just db-up` needed. Requires
# Docker; skips gracefully when Docker is unavailable. NOT in test-unit/CI
# unit run (it needs Docker). Closes the OBS-LIST-1 "Drizzle SQL not
# exercised" gap (metadata->>'rootRunId' + keyset OR-expansion).
test-obs-integration:
    bun test "{{justfile_directory()}}/test/integration/observability-list-reads.drizzle.integration.test.ts"

# JOB-FN-KEY (0.17.1) — function-form concurrency keys serialize at the DB
# level against a real Postgres (testcontainers). Spins its own ephemeral
# postgres:16; skips gracefully when Docker is unavailable. NOT in test-unit/CI
# unit run. Proves two orchestrator instances over one DB persist matching,
# non-null concurrency_keys + the queue-release gate holds the second behind
# the first (the swe-brain ADR-0009 Amendment B §B3 regression).
test-jobs-fnkey-integration:
    bun test "{{justfile_directory()}}/test/integration/jobs-fn-concurrency-key.drizzle.integration.test.ts"

# LISTEN-NOTIFY-2 (0.17.2) — `app.close()` leaves ZERO surviving LISTEN %wake%
# backends. Boots a real Nest context with listen_notify ON (jobs + events)
# against a real Postgres (testcontainers), closes it, and asserts pg_stat_activity
# shows no orphaned listener sockets. Spins its own ephemeral postgres:16; skips
# gracefully when Docker is unavailable. NOT in test-unit/CI unit run. Proves the
# swe-brain boot-check / CI hang (a stop() racing PgNotifyListener.connect()) is gone.
test-listen-notify-leak-integration:
    bun test "{{justfile_directory()}}/test/integration/listen-notify-shutdown-leak.drizzle.integration.test.ts"

# Run the full scaffold validation (Docker + codegen + NestJS + CRUD)
validate:
    bash test/scaffold/validate.sh

# Run all tests
test-all: test-unit test-baseline test-smoke test-smoke-subsystems test-smoke-relationship test-smoke-junction test-smoke-junction-cross-domain test-junction test-integration-emit test-smoke-integration

# ─── Domain Analysis ──────────────────────────────────────────────────────────

# Validate entity YAML files
validate-entities dir="entities/":
    bun codegen validate {{dir}}

# Analyze entities with dependency graph
analyze dir="entities/":
    bun codegen analyze {{dir}}

# Print entity statistics
stats dir="entities/":
    bun codegen stats {{dir}}

# Generate domain documentation
doc dir="entities/" out="domain.md":
    bun codegen doc {{dir}} -o {{out}}

# ─── Manifest & Suggestions ──────────────────────────────────────────────────

# Update the codegen manifest
manifest dir="entities/":
    bun codegen manifest {{dir}}

# Review pending transitive suggestions
suggestions:
    bun codegen suggestions

# ─── Release ──────────────────────────────────────────────────────────────────

# Bump version: just bump patch|minor|major
bump level="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    current=$(jq -r .version package.json)
    IFS='.' read -r major minor patch <<< "$current"
    case "{{level}}" in
        patch) patch=$((patch + 1)) ;;
        minor) minor=$((minor + 1)); patch=0 ;;
        major) major=$((major + 1)); minor=0; patch=0 ;;
        *) echo "Usage: just bump patch|minor|major"; exit 1 ;;
    esac
    new="${major}.${minor}.${patch}"
    # Update package.json version
    tmp=$(mktemp)
    jq --arg v "$new" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json
    echo "Bumped $current → $new"

# Tag and push a release (run after bump + commit)
release:
    #!/usr/bin/env bash
    set -euo pipefail
    version=$(jq -r .version package.json)
    git tag -a "v${version}" -m "Release v${version}"
    git push origin "v${version}"
    echo "Tagged and pushed v${version}"

# Publish origin/main to npm: the root @pattern-stack/codegen + every opted-in
# workspace package (clean worktree, no branch-state assumptions).
#
# Multi-package (ADR-036 §8 — independent versioning): the root publishes first
# (its build emits dist/, which the surface packages' .d.ts builds resolve the
# @pattern-stack/codegen/subsystems import against), then each publishable
# packages/* publishes at its OWN version. A package opts in by declaring
# `publishConfig.access: public` (the 4 surface packages do); private or
# unmarked packages (graph-components, generated api/db) are skipped.
#
# Pass `--dry-run` to pack + validate every tarball WITHOUT uploading:
#   just publish --dry-run
publish *flags:
    #!/usr/bin/env bash
    set -euo pipefail

    git fetch origin main

    version=$(git show origin/main:package.json | jq -r .version)
    is_private=$(git show origin/main:package.json | jq -r '.private // false')

    if [ "$is_private" = "true" ]; then
        echo "ERROR: package.json on origin/main has private:true — refusing to publish."
        echo "Remove the field, tag a new release, then retry."
        exit 1
    fi

    workdir="/tmp/codegen-publish-${version}-$$"
    echo "Publishing @pattern-stack/codegen@${version} (+ surface packages) from origin/main"
    echo "Worktree: ${workdir}"
    [ -n "{{flags}}" ] && echo "Flags: {{flags}}"

    trap 'cd /; git worktree remove --force "${workdir}" 2>/dev/null || true' EXIT

    git worktree add "${workdir}" origin/main
    cd "${workdir}"

    # Resolve toolchain through mise explicitly — the user may also have asdf
    # whose `bun` shim shadows mise in this non-interactive shell and can't
    # resolve a version in the ephemeral worktree (no .tool-versions). Trust the
    # exact workdir and run bun/npm via `mise exec` so .mise.toml wins. Errors
    # are NOT swallowed — a setup failure must abort, not fall through.
    mise trust "${workdir}"
    mise install

    mise exec -- bun install

    # The smoke gate + publish loop live in publish-ci — same path CI takes
    # on merge to main; this recipe only adds the pristine-worktree wrapper.
    mise exec -- just publish-ci {{flags}}

# Publish the CURRENT CHECKOUT to npm — the CI entry point (runs on every
# push to main; see .github/workflows/ci.yml `publish` job). Assumes deps are
# installed and bun/npm are on PATH. Locally, prefer `just publish`, which
# wraps this in a pristine origin/main worktree.
#
# Gate: the tarball smoke (#190) builds + packs everything and verifies the
# consumer contract BEFORE anything uploads — a bad tarball aborts the run.
#
# Then publish one package iff its version isn't already on npm — independent
# versioning (ADR-036 §8), so releasing one surface package doesn't force a
# root or sibling bump. Already-published versions are skipped, not errors.
# This registry check is also what makes "publish on every merge" safe: a
# merge without a version bump is a fast no-op.
#
# Pass `--dry-run` to pack + validate every tarball WITHOUT uploading:
#   just publish-ci --dry-run
publish-ci *flags:
    #!/usr/bin/env bash
    set -euo pipefail

    # Pass 1 — registry check. Emit "dir|name|ver" for every publishable
    # package whose version isn't on npm yet; skip messages go to stderr so
    # they reach the user without polluting the list. Root first — its dist/
    # is what the surface packages' .d.ts builds resolve
    # @pattern-stack/codegen/subsystems against, so publish order matters.
    consider() {
        local dir="$1" name="$2" ver="$3" on_npm
        on_npm=$(npm view "${name}@${ver}" version 2>/dev/null || true)
        if [ "${on_npm}" = "${ver}" ]; then
            echo "↷ skip ${name}@${ver} (already on npm)" >&2
        else
            echo "${dir}|${name}|${ver}"
        fi
    }

    list_unpublished() {
        consider "." "@pattern-stack/codegen" "$(jq -r .version package.json)"
        # Each opted-in workspace package (publishConfig.access: public), at its
        # own version. Private / unmarked (graph-components, generated api/db) skip.
        local pkgjson dir name ver priv access
        for pkgjson in packages/*/package.json; do
            dir=$(dirname "${pkgjson}")
            name=$(jq -r '.name' "${pkgjson}")
            ver=$(jq -r '.version' "${pkgjson}")
            priv=$(jq -r '.private // false' "${pkgjson}")
            access=$(jq -r '.publishConfig.access // ""' "${pkgjson}")
            if [ "${priv}" = "true" ] || [ "${access}" != "public" ]; then
                echo "↷ skip ${name} (not opted in: private=${priv} access=${access:-none})" >&2
                continue
            fi
            consider "${dir}" "${name}" "${ver}"
        done
    }

    to_publish=$(list_unpublished)
    if [ -z "${to_publish}" ]; then
        echo "✓ Nothing to publish — every package version is already on npm."
        exit 0
    fi

    # Gate: tarball smoke (#190) — builds + packs everything, installs into a
    # fresh tmp project, verifies the consumer contract. A bad tarball aborts
    # here, before anything uploads.
    bun test/post-publish/run-tarball-smoke.ts

    # Pass 2 — publish, in list order (root before surface packages).
    while IFS='|' read -r dir name ver; do
        echo "Publishing ${name}@${ver} from ${dir}"
        ( cd "${dir}" && npm publish {{flags}} )
        echo "✓ ${name}@${ver}"
    done <<< "${to_publish}"

    echo "✓ Done."

# ─── Install Skill ────────────────────────────────────────────────────────────

# Install the codegen Claude Code skill into a target project
install-skill target:
    #!/usr/bin/env bash
    set -euo pipefail
    dest="{{target}}/.claude/skills/codegen"
    mkdir -p "$dest"
    cp .claude/skills/codegen/SKILL.md "$dest/SKILL.md"
    echo "Installed codegen skill to $dest"

# Update codegen to latest from source (pull + reinstall)
update:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Pulling latest..."
    git pull --ff-only
    bun install
    version=$(jq -r .version package.json)
    echo "Updated to v${version}"

# ─── Utilities ────────────────────────────────────────────────────────────────

# Start scaffold Postgres (for local dev/testing)
db-up:
    docker compose -f test/scaffold/docker-compose.yml up -d --wait

# Stop scaffold Postgres
db-down:
    docker compose -f test/scaffold/docker-compose.yml down -v

# Push schema to scaffold Postgres
db-push:
    cd test/scaffold && bun run drizzle-kit push --config drizzle.config.ts
