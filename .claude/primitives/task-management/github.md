# Task Management: GitHub Issues

Use GitHub Issues as the source of truth for work items.

## Concepts

| GitHub Term | Generic Term | Description |
|-------------|--------------|-------------|
| Issue | Work Item | Single unit of work |
| Milestone | Epic / Sprint | Collection of issues |
| Label | Tag | Categorization |
| Project (v2) | Board | Kanban-style tracking (optional) |

## Issue Structure

- **Title** (required) — imperative, concise
- **Body** (markdown) — context, acceptance criteria, references
- **State** — `open` | `closed`
- **Labels** — categorization (see below)
- **Assignees**
- **Milestone** (optional) — for epic / sprint grouping
- **Project** (optional) — for board workflow

## Label Taxonomy

Labels are how work is categorized. Common groups:

| Group | Examples |
|-------|----------|
| Stack (where) | `backend`, `frontend`, `infra`, `docs` |
| Type (what) | `feature`, `bug`, `chore`, `refactor`, `spike` |
| Priority | `priority:urgent`, `priority:high`, `priority:low` |
| Status | `in-progress`, `needs-review`, `blocked` |

Exact label names are per-project. When planning, run `gh label list` to see what's available before assigning.

## Workflow

GitHub Issues have only `open` / `closed` states. For richer workflow:
- Use **Projects (v2)** for Kanban columns
- Use **labels** as a lightweight status signal (`in-progress`, `needs-review`)

## CLI Reference

```bash
# Read
gh issue list --state open
gh issue list --label feature --limit 20
gh issue view 123
gh issue view 123 --json title,body,labels,state

# Write
gh issue create --title "Title" --body "Description" --label feature,backend
gh issue edit 123 --add-label in-progress
gh issue close 123

# PR sizing reference (used by planner to calibrate issue size)
gh pr list --state merged --limit 10 --json title,additions,deletions

# Labels
gh label list
gh label create feature --color 0E8A16

# Milestones
gh api repos/:owner/:repo/milestones
```

## Issue Template

```markdown
## Context
{why this work matters}

## Acceptance Criteria
- [ ] {observable outcome 1}
- [ ] {observable outcome 2}

## References
- Spec: `.claude/specs/{slug}.md`
- Related: #N
```
