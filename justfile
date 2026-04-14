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

# Scaffold a subsystem (events, jobs, cache, storage)
gen-subsystem name:
    bun codegen subsystem {{name}}

# ─── Test ─────────────────────────────────────────────────────────────────────

# Run unit tests (base classes + subsystems + scanner + schema)
test-unit:
    bun test src/__tests__/

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
test-all: test-unit test-baseline

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

# ─── Install Skill ────────────────────────────────────────────────────────────

# Install the codegen Claude Code skill into a target project
install-skill target:
    #!/usr/bin/env bash
    set -euo pipefail
    dest="{{target}}/.claude/skills/codegen"
    mkdir -p "$dest"
    cp dist/skill/SKILL.md "$dest/SKILL.md"
    echo "Installed codegen skill to $dest"

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
