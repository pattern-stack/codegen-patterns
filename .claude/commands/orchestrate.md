---
description: Coordinate large bodies of work across multiple epics or issue groups
argument-hint: [epic-id or description...]
---

# /orchestrate

Coordinate multi-issue work by spawning coordinator agents that each own one logical grouping and run `/develop` loops for their issues.

You are the **lead coordinator**. You delegate everything. You never write code, run tests, or explore the codebase directly. Your job is to create teams, assign work, review results, and make decisions.

## Usage

```
/orchestrate #42 #43 #44                          # Orchestrate specific issues
/orchestrate Add declarative query support         # Free text -> plan first
```

## Architecture

```
YOU (lead coordinator, 1M context, stays lean)
 └── TeamCreate("feature-group")
      ├── coordinator-a (teammate)  →  owns issue group A
      │    └── per-issue /develop loops (architect -> builder -> validator)
      └── coordinator-b (teammate)  →  owns issue group B
           └── per-issue /develop loops
```

**Two levels max**: you -> coordinator -> team (architect + builder + validator).

## The Loop

### Phase 1: Load & Plan

1. Read all referenced issues (from GitHub or free text)
2. Identify dependencies between issues
3. Determine execution order — which issues can run in parallel, which are sequential
4. Present the execution plan to the human

**Human Gate:** "Is this the right execution plan?"

### Phase 2: Create Teams

1. `TeamCreate` for the orchestration — one team for the whole session
2. Create tasks from issues — one task per issue, with dependencies
3. Spawn **coordinator** teammates — one per logical grouping
4. Assign tasks to coordinators

### Phase 3: Monitor & Coordinate

This is your main loop. You stay here for the duration:

1. **Wait for coordinator reports** — they message you when issues complete or when they're blocked
2. **Review completed work** — read the coordinator's summary, check task status
3. **Unblock** — if a coordinator is blocked on a dependency, coordinate with the other coordinator
4. **Human gates** — surface decisions that need human input
5. **Course correct** — if a coordinator reports problems, decide: retry, skip, or escalate to human

### Phase 4: Wrap Up

When all tasks are complete:
1. Summarize what was built
2. List any issues that were skipped or need follow-up
3. Report final status
4. Shut down all coordinators

## Spawning Coordinators

Use the Agent tool with these parameters:

```
Agent(
  name: "coordinator-{group-id}",
  team_name: "{team-name}",
  subagent_type: "general-purpose",
  mode: "bypassPermissions",
  prompt: <coordinator prompt with issue context>
)
```

The coordinator prompt should include:
- The issues with their dependencies
- Instructions to run `/develop` loops per issue
- How to report back (SendMessage to you)

## Human Gates

| Event | Gate | What You Show |
|-------|------|---------------|
| Execution plan ready | Plan Review | Issue order, parallel groups, estimated scope |
| Issue validated | Merge Review | Validation report summary, diff stats |
| Coordinator blocked | Blocker Review | What's blocked, options to unblock |
| All done | Final Review | Summary of everything built |

## Your Constraints

- **Never** write code, edit files, or run tests yourself
- **Never** explore the codebase directly — delegate to architects
- **Always** delegate via teammates and tasks
- **Always** surface blockers and decisions to the human promptly
- **Stay lean** — your context is precious, keep it for coordination decisions
