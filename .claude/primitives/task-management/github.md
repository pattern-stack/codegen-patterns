# GitHub Issues Tracker Primitive

Instructions for GitHub Issues integration.

## Concepts

| GitHub Term | Generic Term | Description |
|-------------|--------------|-------------|
| Issue | Work Item | Single unit of work |
| Milestone | Epic/Sprint | Collection of issues |
| Label | Tag | Categorization |
| Project | Board | Kanban-style tracking |

## Issue Structure

```
Issue
├── Title (required)
├── Body (markdown)
├── State (open, closed)
├── Labels (bug, enhancement, etc.)
├── Assignees
├── Milestone
└── Project (optional)
```

## Label Conventions

Use labels for primitive resolution:
- `backend` / `frontend` → language detection
- `bug` / `feature` / `docs`
- `priority:high` / `priority:low`
- `good first issue`

## Workflow

GitHub Issues use open/closed states. For richer workflows:
- Use Projects (beta) for kanban columns
- Use labels to indicate status (`in-progress`, `needs-review`)

## CLI Reference

```bash
# Create issue
gh issue create --title "Title" --body "Description"

# List issues
gh issue list --state open

# View issue
gh issue view 123
```
