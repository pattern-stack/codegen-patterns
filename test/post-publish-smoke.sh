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
RAND=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom 2>/dev/null | head -c 8 || echo "$$")
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

# Verify expected output files actually landed.
EXPECTED_FILES=(
    "$PROJ_DIR/src/domain/lead.entity.ts"
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

# Filter noise that traces to known runtime issues (drizzle 0.30/0.45 mismatch
# and WithAnalytics mixin erasure — see test/smoke/run-smoke.ts:filterConsumerErrors).
# This script is intentionally narrower than the in-source smoke: any
# packaging-related error (ENOENT, missing module, file not found in
# node_modules/) is fatal regardless of where in the typecheck graph it
# surfaces.
if grep -qE 'ENOENT|Cannot find module|MODULE_NOT_FOUND|ResolveMessage' "$TSC_OUT"; then
    grep -E 'ENOENT|Cannot find module|MODULE_NOT_FOUND|ResolveMessage' "$TSC_OUT" >&2 || true
    fail "tsc surfaced module-resolution errors — packaging gap"
fi

# Filter consumer-emitted errors only (mirrors run-smoke.ts logic, lighter).
CONSUMER_ERRORS=$(grep -E 'error TS[0-9]+:' "$TSC_OUT" \
    | grep -v 'node_modules/' \
    | grep -v "Property 'table' in type" \
    | grep -v 'Cannot assign an abstract constructor' \
    | grep -vE "Property '(findBy[A-Z]\\w*|findById|findAll|list|findWithDeleted|findOnlyDeleted)'" \
    | grep -vE '\.schema\.ts\([0-9]+,[0-9]+\): error' \
    || true)

if [ -n "$CONSUMER_ERRORS" ]; then
    printf '%s\n' "$CONSUMER_ERRORS" >&2
    fail "$(printf '%s\n' "$CONSUMER_ERRORS" | wc -l | tr -d ' ') typecheck errors in consumer-emitted code"
fi

log "tsc OK (consumer-emitted code is syntax-clean)"
log "post-publish smoke PASS"
exit 0
