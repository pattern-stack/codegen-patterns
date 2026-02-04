# SDLC Sessions

This directory stores session state for `/develop` and related commands.

## Structure

```
sessions/
├── {session-id}.yml       # Active or completed session
├── {session-id}.yml
└── README.md
```

## Session ID Format

`{command}-{timestamp}-{short-hash}`

Example: `develop-20240129-a3f2`

## Session Schema

```yaml
# Session metadata
id: develop-20240129-a3f2
command: develop
input: "Add keyboard shortcuts to the app"
started: 2024-01-29T10:00:00Z
updated: 2024-01-29T10:45:00Z
status: in_progress | completed | abandoned

# Current position in the workflow
current_phase: understand | plan | spec | implement | validate
current_issue: null | {issue-id}  # For multi-issue workflows

# Phase artifacts (each phase stores its output)
phases:
  understand:
    status: pending | in_progress | approved | skipped
    approved_at: null | timestamp
    artifact: |
      ## Understanding
      ...

  plan:
    status: pending | in_progress | approved | skipped
    approved_at: null | timestamp
    artifact: |
      ## Plan
      ...
    issues:
      - id: "{ISSUE-ID}"
        title: "Issue title"
        status: pending | spec | implementing | validating | done

  spec:
    # Per-issue specs
    "{ISSUE-ID}":
      status: pending | in_progress | approved
      approved_at: null | timestamp
      file: .claude/specs/{issue-slug}.md

  implement:
    "{ISSUE-ID}":
      status: pending | in_progress | done
      branch: {issue-id}/{slug}
      commits: []

  validate:
    "{ISSUE-ID}":
      status: pending | in_progress | passed | failed
      report: |
        ## Validation Report
        ...
      attempts: 1

# Error/retry tracking
errors: []
retries: 0
```

## Lifecycle

1. **Created**: When `/develop` starts, generate session ID and create file
2. **Updated**: After each phase gate (approval or rejection)
3. **Completed**: When all issues are merged or user abandons
4. **Resumed**: If user runs `/develop --resume {session-id}`

## Gitignore

Add to `.gitignore` if you don't want sessions in version control:

```
.claude/sessions/*.yml
!.claude/sessions/README.md
!.claude/sessions/.gitkeep
```

## Cleanup

Old sessions can be manually deleted or archived. Consider a retention policy (e.g., delete sessions older than 30 days).
