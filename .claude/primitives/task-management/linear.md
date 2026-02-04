# Linear Tracker Primitive

Instructions for Linear issue tracking integration.

## Concepts

| Linear Term | Generic Term | Description |
|-------------|--------------|-------------|
| Issue | Work Item | Single unit of work |
| Project | Epic/Initiative | Collection of related issues |
| Cycle | Sprint | Time-boxed iteration |
| Label | Tag | Categorization |

## Issue Structure

```
Issue
├── Title (required)
├── Description (markdown)
├── State (Backlog → Todo → In Progress → Done)
├── Priority (Urgent, High, Medium, Low, None)
├── Labels (stack:backend, type:bug, etc.)
├── Assignee
└── Parent Issue (for sub-tasks)
```

## Label Conventions

Use labels for primitive resolution:
- `stack:backend` → language=python
- `stack:frontend` → language=typescript
- `type:bug` vs `type:feature`
- `quality:strict` vs `quality:fast`

## Workflow States

```
Backlog → Todo → In Progress → In Review → Done
                     ↓
                  Blocked
```

## API Reference

See `tools/linear/` for Linear API toolbox.
