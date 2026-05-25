#!/usr/bin/env bash
# Post-publish smoke — pack the package, install into a fresh tmp project,
# and run the consumer flow. Catches tarball-vs-checkout mismatches that
# `just test-smoke` cannot — that one runs from the source checkout, where
# `src/`, `runtime/`, and `templates/` all coexist regardless of the
# published `files` manifest.
#
# Three regressions of this class have shipped to npm:
#   - 0.3.0  bridge-dist gap (runtimeRoot fallback missing dist/runtime)
#   - 0.4.1  files: array missing runtime/ source
#   - 0.6.0  templates/*.js importing src/config/*.mjs not in files manifest (#266)
#
# This smoke catches all three classes by exercising the actual publish path:
# build -> npm pack -> install tarball -> run consumer commands.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

KEEP=0
FULL=0
for arg in "$@"; do
    case "$arg" in
        --keep) KEEP=1 ;;
        --full) FULL=1 ;;
        -h|--help)
            cat <<EOF
Usage: test/post-publish/run.sh [--keep] [--full]

  --keep   Preserve the tmp project directory after the run.
  --full   Install bridge + jobs subsystems in addition to events.
EOF
            exit 0
            ;;
        *)
            echo "unknown arg: $arg" >&2
            exit 2
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

T0=$(date +%s)
log() {
    local now elapsed
    now=$(date +%s)
    elapsed=$((now - T0))
    printf '[+%4ds] %s\n' "$elapsed" "$*"
}
fail() {
    log "[FAIL] $*"
    exit 1
}

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES_DIR="$REPO_ROOT/test/post-publish/fixtures"
PKG_VERSION=$(jq -r .version "$REPO_ROOT/package.json")
PKG_NAME=$(jq -r .name "$REPO_ROOT/package.json")
BIN_NAME=$(jq -r '.bin | keys[0]' "$REPO_ROOT/package.json")

TMP_BASE="${TMPDIR:-/tmp}"
RAND=$(printf '%08x' $((RANDOM * RANDOM)))
TMP_DIR="$TMP_BASE/post-publish-$RAND"
mkdir -p "$TMP_DIR"

cleanup() {
    local rc=$?
    if [ "$KEEP" -eq 1 ]; then
        log "keeping tmp dir (--keep): $TMP_DIR"
    else
        rm -rf "$TMP_DIR" 2>/dev/null || true
        log "cleaned up $TMP_DIR"
    fi
    exit $rc
}
trap cleanup EXIT

log "repo:    $REPO_ROOT"
log "package: $PKG_NAME@$PKG_VERSION (bin=$BIN_NAME)"
log "tmp dir: $TMP_DIR"

# ---------------------------------------------------------------------------
# 1. Build + npm pack
# ---------------------------------------------------------------------------

log "step 1: build + npm pack"

# `npm pack` does NOT run `prepublishOnly` (only `npm publish` does), so we
# explicitly build to ensure dist/ is current. This also matches what
# consumers actually receive: a tarball with a freshly compiled dist/ that
# the bin entry points into.
cd "$REPO_ROOT"
log "\$ bun run build"
bun run build >/dev/null 2>&1 || fail "bun run build failed"

TARBALL_PATH=$(npm pack --pack-destination "$TMP_DIR" --silent 2>&1 | tail -n 1)
if [ -z "$TARBALL_PATH" ] || [ ! -f "$TMP_DIR/$TARBALL_PATH" ]; then
    fail "npm pack did not produce a tarball (got: '$TARBALL_PATH')"
fi
TARBALL_ABS="$TMP_DIR/$TARBALL_PATH"
log "packed: $TARBALL_ABS ($(du -h "$TARBALL_ABS" | cut -f1))"

# ---------------------------------------------------------------------------
# 2. Fresh tmp project + install tarball
# ---------------------------------------------------------------------------

log "step 2: scaffold fresh project + install tarball"

PROJ_DIR="$TMP_DIR/proj"
mkdir -p "$PROJ_DIR"
cd "$PROJ_DIR"

bun init -y >/dev/null 2>&1 || npm init -y >/dev/null

# Pinned peer deps the consumer needs to typecheck the generated code.
# Mirrors test/smoke/run-smoke.ts so failures are easy to triage by diffing
# the two harnesses.
RUNTIME_DEPS=(
    "@nestjs/common@10"
    "@nestjs/core@10"
    "@nestjs/platform-express@10"
    "@nestjs/swagger@7"
    "@anatine/zod-openapi@2"
    "drizzle-orm@0.45"
    "reflect-metadata@0.2"
    "pg@8"
    "zod@3"
    "yaml@2"
)
DEV_DEPS=(
    "typescript@5"
    "@types/node@latest"
    "@types/pg@8"
)

if command -v bun >/dev/null 2>&1; then
    bun add "${RUNTIME_DEPS[@]}" >/dev/null 2>&1 || fail "bun add runtime deps failed"
    bun add -D "${DEV_DEPS[@]}" >/dev/null 2>&1 || fail "bun add dev deps failed"
    bun add "$TARBALL_ABS" >/dev/null 2>&1 || fail "bun add tarball failed"
else
    npm install --silent "${RUNTIME_DEPS[@]}" || fail "npm install runtime deps failed"
    npm install --silent --save-dev "${DEV_DEPS[@]}" || fail "npm install dev deps failed"
    npm install --silent "$TARBALL_ABS" || fail "npm install tarball failed"
fi

# Verify the bin resolves. This catches the most basic packaging breakage
# (missing dist/, wrong main entry, etc.) before we exercise commands.
BIN_PATH="$PROJ_DIR/node_modules/.bin/$BIN_NAME"
if [ ! -x "$BIN_PATH" ]; then
    fail "bin '$BIN_NAME' not found at $BIN_PATH after install"
fi
log "bin resolved: $BIN_PATH"

# ---------------------------------------------------------------------------
# 3. Consumer flows: project init + subsystem install + entity new
# ---------------------------------------------------------------------------

run_cli() {
    local label="$1"; shift
    log "\$ $BIN_NAME $*"
    local out
    if ! out=$("$BIN_PATH" "$@" 2>&1); then
        echo "$out" >&2
        fail "$label failed: $BIN_NAME $*"
    fi
    # Even on exit 0, watch for ENOENT or ResolveMessage in stderr-merged output.
    # These were the actual failure modes for #266, #226 (0.4.1), and the
    # 0.3.0 bridge-dist gap.
    if printf '%s\n' "$out" | grep -qE 'ENOENT|ResolveMessage|Cannot find module|MODULE_NOT_FOUND'; then
        echo "$out" >&2
        fail "$label emitted ENOENT/missing-module diagnostic — packaging gap detected"
    fi
}

log "step 3a: project init"
run_cli "project init" project init --yes --with-tsconfig

log "step 3b: subsystem install events"
run_cli "subsystem install events" subsystem install events

if [ "$FULL" -eq 1 ]; then
    log "step 3c: subsystem install jobs (--full)"
    run_cli "subsystem install jobs" subsystem install jobs
    log "step 3d: subsystem install bridge (--full)"
    run_cli "subsystem install bridge" subsystem install bridge
fi

# ---------------------------------------------------------------------------
# 4. Generate an entity using the multi-provider detection: fixture (#266 path).
# ---------------------------------------------------------------------------

log "step 4: copy fixture + entity new (multi-provider detection)"

ENTITIES_DIR="$PROJ_DIR/entities"
mkdir -p "$ENTITIES_DIR"
rm -f "$ENTITIES_DIR/example.yaml"

if [ ! -d "$FIXTURES_DIR" ] || [ -z "$(ls -A "$FIXTURES_DIR"/*.yaml 2>/dev/null)" ]; then
    fail "no post-publish fixtures found at $FIXTURES_DIR"
fi
cp "$FIXTURES_DIR"/*.yaml "$ENTITIES_DIR/"
log "copied fixtures: $(ls "$ENTITIES_DIR" | tr '\n' ' ')"

run_cli "entity new --all" entity new --all --force

# Verify expected output files actually landed. The fixture exercises the
# multi-provider `detection:` codegen path, so we assert both the entity
# itself (proves the entity-emit ran under the default `clean-lite-ps`
# architecture written by `cdp project init`) and the sync-source module
# + providers (proves the detection-block templates rendered — the exact
# code path that shipped broken in 0.6.0).
#
# We also assert `events.module.ts` landed: `project init` baseline-vendors
# `event-bus.protocol.ts`, which used to trip subsystem detection into
# reporting events as "already installed" — so `subsystem install events`
# no-op'd and the events runtime (module + backends) never copied, leaving
# the generated subsystems barrel importing a non-existent module. Asserting
# the module file guards that the install actually ran.
EXPECTED_FILES=(
    "$PROJ_DIR/src/modules/leads/lead.entity.ts"
    "$PROJ_DIR/src/modules/leads/lead-sync-source.module.ts"
    "$PROJ_DIR/src/modules/leads/lead-sync-source.providers.ts"
    "$PROJ_DIR/src/shared/subsystems/events/events.module.ts"
)
for f in "${EXPECTED_FILES[@]}"; do
    if [ ! -f "$f" ]; then
        log "tree of src/:"
        find "$PROJ_DIR/src" -type f 2>/dev/null | head -50 >&2 || true
        fail "expected generated file missing: $f"
    fi
done
log "generated files present"

# ---------------------------------------------------------------------------
# 5. Typecheck the generated project.
# ---------------------------------------------------------------------------

log "step 5: bunx tsc --noEmit --skipLibCheck"

cd "$PROJ_DIR"
TSC_OUT="$TMP_DIR/tsc.log"
if command -v bun >/dev/null 2>&1; then
    bunx tsc --noEmit --skipLibCheck >"$TSC_OUT" 2>&1 || true
else
    npx tsc --noEmit --skipLibCheck >"$TSC_OUT" 2>&1 || true
fi

# Packaging-gap detector. Restrict to errors that point at the tarball
# itself or anything under node_modules/, plus the bare ENOENT /
# MODULE_NOT_FOUND signatures emitted from runtime require() failures.
# Consumer-emitted code with broken relative imports (e.g. a generated
# file referencing `../../domain` that doesn't exist under the chosen
# architecture) is a codegen template bug, NOT a tarball gap — those
# fall through to the consumer-error filter below.
PACKAGING_HITS=$(grep -E 'ENOENT|MODULE_NOT_FOUND|ResolveMessage' "$TSC_OUT" \
    || true)
PACKAGING_HITS+=$'\n'$(grep -E 'Cannot find module' "$TSC_OUT" \
    | grep -E "from '(\.\\.?/)*node_modules/|@pattern-stack/codegen|'@nestjs/|'drizzle-orm" \
    || true)
if [ -n "$(printf '%s' "$PACKAGING_HITS" | tr -d '[:space:]')" ]; then
    printf '%s\n' "$PACKAGING_HITS" >&2
    fail "tsc surfaced module-resolution errors against the tarball — packaging gap"
fi

# Filter consumer-emitted errors only (mirrors run-smoke.ts logic, lighter).
#
# Known template-drift exclusions (separate from packaging gaps; these
# are codegen-template bugs to be fixed in their own PRs):
# - `lead-sync-source.module.ts` and the `events/generated/bus.ts` import
#   paths assume layouts/files not present under every architecture +
#   subsystem combination. The post-publish smoke's job is to catch
#   tarball gaps, not to gate on template correctness — that's
#   `just test-smoke`'s job.
CONSUMER_ERRORS=$(grep -E 'error TS[0-9]+:' "$TSC_OUT" \
    | grep -v 'node_modules/' \
    | grep -v "Property 'table' in type" \
    | grep -v 'Cannot assign an abstract constructor' \
    | grep -vE "Property '(findBy[A-Z]\\w*|findById|findAll|list|findWithDeleted|findOnlyDeleted)'" \
    | grep -vE '\.schema\.ts\([0-9]+,[0-9]+\): error' \
    | grep -vE 'sync-source\.module\.ts.*Cannot find module' \
    | grep -vE 'subsystems/events/generated/bus\.ts.*Cannot find module' \
    || true)

if [ -n "$CONSUMER_ERRORS" ]; then
    printf '%s\n' "$CONSUMER_ERRORS" >&2
    fail "$(printf '%s\n' "$CONSUMER_ERRORS" | wc -l | tr -d ' ') typecheck errors in consumer-emitted code"
fi

log "tsc OK (consumer-emitted code is syntax-clean)"
log "post-publish smoke PASS"
exit 0
