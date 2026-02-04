#!/bin/bash
# Setup a worktree for merge work
# Usage: ./setup-worktree.sh <worktree-name>
# Example: ./setup-worktree.sh eng-26-tree-components

set -e

WORKTREE_NAME="$1"
WORKTREE_PATH="/Users/doug/Work/dev/worktrees/$WORKTREE_NAME"
MAIN_REPO="/Users/doug/Work/dev/dealbrain"

if [ -z "$WORKTREE_NAME" ]; then
  echo "Usage: $0 <worktree-name>"
  echo "Available worktrees:"
  git worktree list | grep worktrees
  exit 1
fi

if [ ! -d "$WORKTREE_PATH" ]; then
  echo "Error: Worktree not found at $WORKTREE_PATH"
  exit 1
fi

echo "=== Setting up $WORKTREE_NAME ==="

# 1. Reset to latest main
echo "1. Resetting to origin/main..."
cd "$WORKTREE_PATH"
git fetch origin
git reset --hard origin/main
echo "   Now at: $(git log --oneline -1)"

# 2. Copy .claude folder
echo "2. Copying .claude folder..."
rm -rf "$WORKTREE_PATH/.claude"
cp -R "$MAIN_REPO/.claude" "$WORKTREE_PATH/.claude"
echo "   Copied .claude/"

# 3. Install dependencies
echo "3. Installing dependencies..."
cd "$WORKTREE_PATH"
bun install

# 4. Verify build
echo "4. Verifying TypeScript..."
cd "$WORKTREE_PATH/apps/frontend"
bunx tsc --noEmit 2>&1 | head -5 || true

echo ""
echo "=== Setup complete ==="
echo "Worktree: $WORKTREE_PATH"
echo "Plan: $MAIN_REPO/.claude/merge-plan/${WORKTREE_NAME%-*}*.md"
echo ""
echo "Next: Open the plan file and follow the tasks"
