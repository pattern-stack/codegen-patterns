#!/usr/bin/env bash
#
# scripts/publish.sh — publish @pattern-stack/codegen to npm.
#
# Usage:
#   bash scripts/publish.sh              # pre-flight dry-run
#   bash scripts/publish.sh publish      # real publish (default tag: latest)
#   bash scripts/publish.sh publish --tag=next

set -euo pipefail

MODE="${1:-check}"
shift || true
TAG="latest"
for arg in "$@"; do
  case "$arg" in
    --tag=*) TAG="${arg#--tag=}" ;;
    *) ;;
  esac
done

cd "$(dirname "$0")/.."

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }
ok()    { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m!\033[0m %s\n" "$*"; }
fail()  { printf "  \033[31m✗\033[0m %s\n" "$*"; exit 1; }

bold "pre-flight"

if [ -n "$(git status --porcelain)" ]; then
  warn "git tree is dirty"
  git status --short
  [ "$MODE" = "publish" ] && fail "refusing to publish with uncommitted changes"
else
  ok "git tree clean"
fi

if [ "$MODE" = "publish" ]; then
  npm whoami >/dev/null 2>&1 || fail "not logged in to npm — run: npm login"
  ok "npm user: $(npm whoami)"
fi

bold "build + typecheck"
bun run build >/dev/null
ok "build"
bunx tsc --noEmit -p tsconfig.build.json >/dev/null
ok "typecheck"

bold "dry-run pack"
echo
npm pack --dry-run 2>&1 | grep -E "^(npm notice name:|npm notice version:|npm notice package size:|npm notice total files:)" || true
echo

bold "version on disk"
node -e "const p=require('./package.json'); console.log('  '+p.name.padEnd(32)+p.version);"

case "$MODE" in
  check)
    echo
    dim "run \`bash scripts/publish.sh publish\` to actually publish with tag=$TAG"
    ;;
  publish)
    echo
    bold "publishing to npm (tag=$TAG)"
    echo
    npm publish --tag="$TAG" --access=public
    echo
    ok "done — verify at https://www.npmjs.com/package/@pattern-stack/codegen"
    ;;
  *)
    fail "unknown mode: $MODE (expected: check | publish)"
    ;;
esac
