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

# Run unit tests (base classes + subsystems + scanner + schema)
test-unit:
    bun test src/__tests__/

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

# Run baseline test (generate + compare to baseline)
test-baseline:
    bun test/run-test.ts full

# Capture current output as new baseline
baseline:
    bun test/run-test.ts baseline

# Compare gen/ to baseline/ (no regeneration)
compare:
    bun test/run-test.ts compare

# Run family repo integration tests (requires Docker + db-up + db-push)
test-family:
    bun test test/scaffold/tests/crm-entity-repository.test.ts test/scaffold/tests/activity-entity-repository.test.ts test/scaffold/tests/metadata-entity-repository.test.ts

# Run scaffold integration tests (requires Docker)
test-integration:
    bun test/scaffold/run-integration.ts

# Run integration tests, skip codegen (already generated)
test-integration-quick:
    bun test/scaffold/run-integration.ts --skip-codegen

# Run the full scaffold validation (Docker + codegen + NestJS + CRUD)
validate:
    bash test/scaffold/validate.sh

# Run all tests
test-all: test-unit test-baseline test-smoke test-smoke-junction test-smoke-junction-cross-domain

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

# Publish current origin/main to npm (clean worktree, no branch-state assumptions)
publish:
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
    echo "Publishing @pattern-stack/codegen@${version} from origin/main"
    echo "Worktree: ${workdir}"

    trap 'cd /; git worktree remove --force "${workdir}" 2>/dev/null || true' EXIT

    git worktree add "${workdir}" origin/main
    cd "${workdir}"

    mise trust >/dev/null 2>&1 || true
    mise install >/dev/null 2>&1 || true

    bun install
    npm publish

    echo "✓ Published @pattern-stack/codegen@${version}"

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
