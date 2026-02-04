# Jira Tracker Primitive

Instructions for Jira issue tracking integration.

## Concepts

| Jira Term | Generic Term | Description |
|-----------|--------------|-------------|
| Issue | Work Item | Single unit of work |
| Epic | Epic | Large feature/initiative |
| Story | Feature | User-facing functionality |
| Task | Task | Technical work item |
| Bug | Bug | Defect |
| Sprint | Sprint | Time-boxed iteration |

## Issue Structure

```
Issue
├── Summary (required)
├── Description (rich text)
├── Issue Type (Epic, Story, Task, Bug)
├── Status (per workflow)
├── Priority (Highest, High, Medium, Low, Lowest)
├── Labels
├── Components
├── Assignee
├── Sprint
└── Epic Link
```

## Workflow States

Typical workflow (varies by project):
```
To Do → In Progress → In Review → Done
              ↓
           Blocked
```

## Label Conventions

Use labels or components for primitive resolution:
- Component: `backend`, `frontend`, `infrastructure`
- Labels: `tech-debt`, `security`, `performance`

## JQL Reference

```
# Find issues in sprint
sprint = "Sprint 1" AND status != Done

# Find my issues
assignee = currentUser() AND status = "In Progress"
```
