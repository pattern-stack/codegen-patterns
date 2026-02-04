# Session Logging Primitive

Structured logging for SDLC workflows. Provides audit trail, resume capability, and human-readable artifacts.

## Philosophy

Sessions are **execution journals** — they capture:
1. What was requested
2. What was decided (human gates)
3. What was produced (artifacts)
4. What happened (logs)

Logs are **git-committed** for traceability and team visibility.

## Directory Structure

```
agent-logs/
└── {session-id}/
    ├── session.yaml           ← Session metadata + state
    ├── request.md             ← Original user request
    │
    ├── phases/                ← Execution trail (ordered)
    │   ├── 1-understand/
    │   │   ├── artifact.md    ← Understanding output
    │   │   └── decision.md    ← Human gate decision
    │   ├── 2-plan/
    │   │   ├── artifact.md    ← Issue tree
    │   │   └── decision.md    ← Human approval + adjustments
    │   └── 3-execute/
    │       ├── {issue-id}/    ← Per-issue execution
    │       │   ├── spec.md
    │       │   ├── implement.log
    │       │   ├── validate.md
    │       │   └── decision.md
    │       └── {issue-id-2}/
    │           └── ...
    │
    ├── gates/                 ← Quality gate outputs
    │   ├── typecheck.log
    │   ├── lint.log
    │   ├── test.log
    │   └── summary.json       ← Structured gate results
    │
    ├── artifacts/             ← Reusable outputs (symlinks or copies)
    │   ├── specs/             ← Links to .claude/specs/
    │   └── branches.md        ← Branch → issue mapping
    │
    └── summary.md             ← Human-readable session summary
```

## Session ID Format

```
{workflow}-{date}-{hash}
```

Examples:
- `develop-20240129-a3f2`
- `review-20240129-b7c1`
- `hotfix-20240129-d9e4`

## Session YAML Schema

```yaml
# session.yaml
id: develop-20240129-a3f2
workflow: develop
created: 2024-01-29T10:00:00Z
updated: 2024-01-29T14:30:00Z
status: in_progress | completed | abandoned | blocked

# Original request
request:
  raw: "Add keyboard shortcuts to the app"
  parsed:
    type: idea | issue_id | resume
    value: "Add keyboard shortcuts to the app"

# Git context at session start
context:
  branch: feat/keyboard-shortcuts
  base: main
  commit: abc1234

# Current position (for resume)
cursor:
  phase: execute
  issue: PROJ-42
  step: validate

# Phase statuses
phases:
  understand:
    status: approved
    started: 2024-01-29T10:00:00Z
    completed: 2024-01-29T10:15:00Z

  plan:
    status: approved
    started: 2024-01-29T10:15:00Z
    completed: 2024-01-29T10:30:00Z
    issues:
      - id: PROJ-42
        title: Create shortcuts registry
        status: done
      - id: PROJ-43
        title: Add shortcuts UI
        status: implementing
      - id: PROJ-44
        title: Integration tests
        status: pending
        blocked_by: [PROJ-42, PROJ-43]

  execute:
    PROJ-42:
      spec: approved
      implement: done
      validate: passed
      branch: proj-42/shortcuts-registry
      pr: "#123"
    PROJ-43:
      spec: approved
      implement: in_progress
      validate: pending
      branch: proj-43/shortcuts-ui

# Decisions log (human gates)
decisions:
  - phase: understand
    timestamp: 2024-01-29T10:15:00Z
    gate: "Did I get this right?"
    response: approved
    notes: "Also consider accessibility"

  - phase: plan
    timestamp: 2024-01-29T10:30:00Z
    gate: "Is this the right breakdown?"
    response: approved
    adjustments:
      - "Split UI into two subtasks"

# Errors encountered
errors: []

# Final outputs
outputs:
  issues_created: [PROJ-42, PROJ-43, PROJ-44]
  prs_created: ["#123"]
  specs_written:
    - .claude/specs/proj-42-shortcuts-registry.md
    - .claude/specs/proj-43-shortcuts-ui.md
```

## Phase Artifacts

### 1. Understanding Phase

```markdown
# Understanding Artifact

## Request
{Original user request}

## Restatement
{1-2 sentence restatement proving comprehension}

## Context
- **Problem**: {what's broken/missing}
- **Users**: {who benefits}
- **Systems**: {what's touched}

## Relevant Code
{Tree diagram of relevant files}

## Patterns Identified
- {Existing pattern to follow}

## Open Questions
- {Clarifications needed}
```

### 2. Plan Phase

```markdown
# Plan Artifact

## Issue Tree
{ASCII tree with issues, labels, dependencies}

## Dependency Graph
{ASCII showing execution order}

## Issues

### {ISSUE-ID}: {Title}
- **Stack**: {Frontend/Backend/etc}
- **Type**: {Feature/Bug/etc}
- **Size**: {S/M/L}
- **Blocks**: {dependencies}
- **Description**: {2-3 sentences}
- **Acceptance Criteria**:
  - [ ] {criterion}
```

### 3. Execute Phase (per issue)

**spec.md**:
```markdown
# Spec: {Issue Title}

**Issue**: {ISSUE-ID}
**Status**: Draft | Approved

## Overview
{What this delivers}

## Files
| File | Action | Purpose |
|------|--------|---------|

## Interface
{Types/signatures}

## Steps
1. {Step}

## Open Questions
- {Decision needed}
```

**implement.log**:
```markdown
# Implementation Log: {ISSUE-ID}

## Branch
`{branch-name}`

## Progress
- [x] Step 1: {description}
- [x] Step 2: {description}
- [ ] Step 3: {description}

## Files Changed
| File | Action | Lines |
|------|--------|-------|

## Commits
- `abc123` {message}

## Issues Encountered
{Any blockers or deviations}
```

**validate.md**:
```markdown
# Validation Report: {ISSUE-ID}

## Gates
| Gate | Status | Notes |
|------|--------|-------|
| Type Check | ✓ | — |
| Lint | ✓ | — |
| Tests | ✓ | 12 passed |

## Spec Compliance
- [x] All files created
- [x] Interfaces match
- [x] Steps completed

## Recommendation
✓ Ready for review | ✗ Needs work
```

### Decision Files

```markdown
# Decision: {Phase} Gate

**Timestamp**: {ISO timestamp}
**Gate**: "{question asked}"
**Response**: approved | rejected | adjusted

## User Feedback
{What the user said}

## Adjustments Made
- {Change based on feedback}

## Rationale
{Why this decision was made}
```

## Session Lifecycle

### 1. Initialize

```bash
WORKFLOW="develop"
HASH=$(openssl rand -hex 2)
SESSION_ID="${WORKFLOW}-$(date +%Y%m%d)-${HASH}"
SESSION_DIR="agent-logs/$SESSION_ID"

mkdir -p "$SESSION_DIR"/{phases/1-understand,phases/2-plan,phases/3-execute,gates,artifacts}
```

### 2. Log Phase Start

```bash
echo "Starting phase: understand" >> "$SESSION_DIR/session.log"
# Update session.yaml cursor
```

### 3. Record Decision

After each human gate:
```bash
cat > "$SESSION_DIR/phases/1-understand/decision.md" <<EOF
# Decision: Understand Gate

**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Gate**: "Did I get this right?"
**Response**: approved

## User Feedback
$USER_RESPONSE

## Adjustments Made
- None
EOF
```

### 4. Finalize Session

```bash
# Update session.yaml status
# Generate summary.md
# Commit to git

git add agent-logs/$SESSION_ID/
git commit -m "docs(session): $SESSION_ID - $WORKFLOW completed

Issues: $ISSUES_CREATED
PRs: $PRS_CREATED

Co-Authored-By: Claude <noreply@anthropic.com>"
```

## Resume Protocol

1. Find session: `ls -t agent-logs/ | head -1` or `--resume {session-id}`
2. Load `session.yaml`
3. Read `cursor` to find position
4. Continue from that point
5. Preserve all existing artifacts

## Git Integration

Sessions are committed at:
- Session completion (success or abandon)
- Each phase completion (optional, for long sessions)
- Error states (preserve progress)

Commit message format:
```
docs(session): {session-id} - {status}

Workflow: {workflow}
Issues: {list}
Duration: {time}

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Cleanup Policy

Recommended retention:
- **Completed sessions**: Keep 30 days, then archive or delete
- **Abandoned sessions**: Keep 7 days
- **In-progress sessions**: Keep indefinitely until resolved

Archive command:
```bash
tar -czf agent-logs/archive/$(date +%Y%m).tar.gz agent-logs/develop-2024*
rm -rf agent-logs/develop-2024*
```
