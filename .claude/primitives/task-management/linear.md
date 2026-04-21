# Task Management: Linear

Use Linear as the source of truth for work items.

## Concepts

| Linear Term | Generic Term | Description |
|-------------|--------------|-------------|
| Issue | Work Item | Single unit of work |
| Project | Epic / Initiative | Collection of related issues |
| Cycle | Sprint | Time-boxed iteration |
| Label | Tag | Categorization |
| Team | Scope | Workspace partition (each issue belongs to one team) |

## Issue Structure

- **Title** (required)
- **Description** (markdown)
- **State** — `Backlog` → `Todo` → `In Progress` → `In Review` → `Done` (plus `Canceled`, `Blocked`)
- **Priority** — `Urgent` | `High` | `Medium` | `Low` | `None`
- **Labels** — categorization (e.g., `stack:backend`, `type:bug`)
- **Assignee**
- **Parent Issue** — for sub-tasks (supports a few levels of nesting)
- **Cycle** — for time-boxed iteration planning
- **Project** — for epic / initiative grouping

## Label Taxonomy

Linear labels are team-scoped. Common groups:

| Group | Examples |
|-------|----------|
| Stack | `stack:backend`, `stack:frontend`, `stack:infra` |
| Type | `type:feature`, `type:bug`, `type:chore` |
| Quality | `quality:strict`, `quality:fast` |

When planning, list labels for the team before assigning (see below).

## Access

Prefer the **Linear MCP tools** (`mcp__…__Linear__*`) when available — they expose typed read/write endpoints without manual GraphQL. Fall back to the Linear API directly only if MCP is not configured.

### Common Operations (MCP)

| Task | Tool |
|------|------|
| List teams | `list_teams` |
| List issues in a team | `list_issues` |
| View issue | `get_issue` |
| Create / update issue | `save_issue` |
| List labels | `list_issue_labels` |
| Create label | `create_issue_label` |
| List cycles | `list_cycles` |
| List projects | `list_projects` |
| Add comment | `save_comment` |

### Issue Template

```markdown
## Context
{why this work matters}

## Acceptance Criteria
- [ ] {observable outcome 1}
- [ ] {observable outcome 2}

## References
- Spec: `.claude/specs/{slug}.md`
- Parent: {ISSUE-ID}
```

## Workflow

```
Backlog -> Todo -> In Progress -> In Review -> Done
                       |
                    Blocked
```

State transitions are enforced per team in Linear's settings — some teams require a reviewer before `Done`. When scripting transitions, confirm the workflow first.
