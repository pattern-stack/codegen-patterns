#!/usr/bin/env bash
# test/scaffold/validate.sh
#
# Full integration loop: generates contact entity, migrates schema, starts
# NestJS app, exercises CRUD endpoints, then tears down.
#
# IMPORTANT — Simplified entity:
#   This script uses test/scaffold/contact-scaffold.yaml (not contact-v2.yaml).
#   contact-v2.yaml uses family: crm-synced and external_id_tracking behavior
#   which depend on CrmEntityRepository/CrmEntityService that are not yet
#   implemented. contact-scaffold.yaml uses family: base which only requires
#   BaseRepository and BaseService (provided by test/scaffold/shared/).
#
# Usage:
#   bash test/scaffold/validate.sh
#   or: chmod +x test/scaffold/validate.sh && ./test/scaffold/validate.sh
#
# Requirements:
#   - Docker (for Postgres 16)
#   - bun (runtime)
#   - hygen (peer dep: bun add -d hygen from repo root)
#
set -euo pipefail

SCAFFOLD_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCAFFOLD_DIR/../.." && pwd)"
CODEGEN_CONFIG="$REPO_ROOT/codegen.config.yaml"
CODEGEN_CONFIG_BACKUP="$REPO_ROOT/codegen.config.yaml.scaffold-bak"

# ---------------------------------------------------------------------------
# Cleanup function — always runs on exit (success or failure)
# ---------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  echo "==> Cleanup (exit_code=$exit_code)"

  # Kill the app if still running
  if [ -n "${APP_PID:-}" ]; then
    kill "$APP_PID" 2>/dev/null || true
  fi

  # Tear down Docker
  docker compose -f "$SCAFFOLD_DIR/docker-compose.yml" down -v 2>/dev/null || true

  # Restore or remove the temporary codegen config
  if [ -f "$CODEGEN_CONFIG_BACKUP" ]; then
    mv "$CODEGEN_CONFIG_BACKUP" "$CODEGEN_CONFIG"
  elif [ "${SCAFFOLD_CONFIG_CREATED:-false}" = "true" ]; then
    rm -f "$CODEGEN_CONFIG"
  fi

  exit "$exit_code"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Install scaffold dependencies
# ---------------------------------------------------------------------------
echo "==> Installing scaffold dependencies"
cd "$SCAFFOLD_DIR"
bun install

# ---------------------------------------------------------------------------
# 2. Create a temporary codegen.config.yaml with clean-lite-ps architecture
#    The test runner (run-test.ts) also manages this file, so we back it up
#    if it already exists and restore it in the cleanup function.
# ---------------------------------------------------------------------------
echo "==> Setting up codegen config for scaffold"
cd "$REPO_ROOT"
if [ -f "$CODEGEN_CONFIG" ]; then
  cp "$CODEGEN_CONFIG" "$CODEGEN_CONFIG_BACKUP"
fi
SCAFFOLD_CONFIG_CREATED=true

cat > "$CODEGEN_CONFIG" << 'YAML_EOF'
# Temporary config created by test/scaffold/validate.sh
# Cleaned up automatically on exit.
generate:
  architecture: clean-lite-ps
  frontend: false
YAML_EOF

# ---------------------------------------------------------------------------
# 3. Start Postgres
# ---------------------------------------------------------------------------
echo "==> Starting Postgres"
docker compose -f "$SCAFFOLD_DIR/docker-compose.yml" up -d --wait

# ---------------------------------------------------------------------------
# 4. Run codegen
#    Uses contact-scaffold.yaml (base family, no CRM dependencies).
#    Output lands at <repo-root>/modules/contacts/ (Hygen output path).
# ---------------------------------------------------------------------------
echo "==> Running codegen for contact-scaffold"
cd "$REPO_ROOT"
bun codegen entity test/scaffold/contact-scaffold.yaml

# ---------------------------------------------------------------------------
# 5. Push schema with drizzle-kit
# ---------------------------------------------------------------------------
echo "==> Running drizzle-kit push"
cd "$SCAFFOLD_DIR"
bun run drizzle-kit push --config drizzle.config.ts

# ---------------------------------------------------------------------------
# 6. Start NestJS app in background
# ---------------------------------------------------------------------------
echo "==> Starting NestJS app"
cd "$SCAFFOLD_DIR"
APP_PID=""
bun run start &
APP_PID=$!

# Wait until port 3000 accepts connections (max 20s)
echo "==> Waiting for app to be ready..."
for i in $(seq 1 20); do
  if curl -sf http://localhost:3000/contacts > /dev/null 2>&1; then
    echo "    App ready after ${i}s"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "ERROR: App did not start within 20 seconds"
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# 7. CRUD assertions
# ---------------------------------------------------------------------------
echo "==> POST /contacts (create)"
CREATE_RESPONSE=$(curl -sf -X POST http://localhost:3000/contacts \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Ada","lastName":"Lovelace","email":"ada@example.com"}')
echo "$CREATE_RESPONSE"

# Extract contact ID — prefer jq, fall back to python3
if command -v jq > /dev/null 2>&1; then
  CONTACT_ID=$(echo "$CREATE_RESPONSE" | jq -r '.id')
else
  CONTACT_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
fi

if [ -z "$CONTACT_ID" ] || [ "$CONTACT_ID" = "null" ]; then
  echo "ERROR: POST did not return an id"
  exit 1
fi
echo "    Created contact id=$CONTACT_ID"

echo "==> GET /contacts (list)"
LIST_RESPONSE=$(curl -sf http://localhost:3000/contacts)
echo "$LIST_RESPONSE"
if command -v jq > /dev/null 2>&1; then
  LIST_LEN=$(echo "$LIST_RESPONSE" | jq 'length')
else
  LIST_LEN=$(echo "$LIST_RESPONSE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
fi
if [ "$LIST_LEN" -lt 1 ]; then
  echo "ERROR: GET /contacts returned empty array"
  exit 1
fi
echo "    list ok, count=$LIST_LEN"

echo "==> GET /contacts/:id"
GET_RESPONSE=$(curl -sf "http://localhost:3000/contacts/$CONTACT_ID")
echo "$GET_RESPONSE"
if command -v jq > /dev/null 2>&1; then
  FETCHED_ID=$(echo "$GET_RESPONSE" | jq -r '.id')
else
  FETCHED_ID=$(echo "$GET_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
fi
if [ "$FETCHED_ID" != "$CONTACT_ID" ]; then
  echo "ERROR: GET /contacts/:id returned wrong id (got $FETCHED_ID, expected $CONTACT_ID)"
  exit 1
fi
echo "    get-by-id ok"

echo "==> PUT /contacts/:id (update)"
UPDATE_RESPONSE=$(curl -sf -X PUT "http://localhost:3000/contacts/$CONTACT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Mathematician"}')
echo "$UPDATE_RESPONSE"
if command -v jq > /dev/null 2>&1; then
  UPDATED_TITLE=$(echo "$UPDATE_RESPONSE" | jq -r '.title')
else
  UPDATED_TITLE=$(echo "$UPDATE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['title'])")
fi
if [ "$UPDATED_TITLE" != "Mathematician" ]; then
  echo "ERROR: PUT did not update title (got $UPDATED_TITLE)"
  exit 1
fi
echo "    update ok"

echo "==> DELETE /contacts/:id (soft-delete)"
DELETE_RESPONSE=$(curl -sf -X DELETE "http://localhost:3000/contacts/$CONTACT_ID")
echo "$DELETE_RESPONSE"
if command -v jq > /dev/null 2>&1; then
  DELETED_ID=$(echo "$DELETE_RESPONSE" | jq -r '.id')
else
  DELETED_ID=$(echo "$DELETE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
fi
if [ "$DELETED_ID" != "$CONTACT_ID" ]; then
  echo "ERROR: DELETE response missing correct id (got $DELETED_ID)"
  exit 1
fi
echo "    delete (soft) ok"

# ---------------------------------------------------------------------------
# 8. Done (cleanup runs via trap)
# ---------------------------------------------------------------------------
echo ""
echo "==> All checks passed"
exit 0
