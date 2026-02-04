# Session State Primitive

Instructions for managing SDLC session state.

## Location

Sessions are stored in `.claude/sessions/{session-id}.yml`

## Operations

### Create Session

When starting a new `/develop` or similar command:

```bash
# Generate session ID
SESSION_ID="{command}-$(date +%Y%m%d)-$(openssl rand -hex 2)"
# Example: develop-20240129-a3f2
```

Create initial session file:

```yaml
id: {SESSION_ID}
command: {command}
input: "{user's original input}"
started: {ISO timestamp}
updated: {ISO timestamp}
status: in_progress
current_phase: understand
current_issue: null
phases:
  understand:
    status: pending
  plan:
    status: pending
  spec: {}
  implement: {}
  validate: {}
errors: []
retries: 0
```

### Update Phase Status

After phase completion or approval:

```yaml
phases:
  {phase}:
    status: approved  # or rejected, skipped
    approved_at: {ISO timestamp}
    artifact: |
      {The output artifact from this phase}
```

### Track Issues

When plan is approved, populate issues:

```yaml
phases:
  plan:
    issues:
      - id: "PROJ-123"
        title: "Create shortcuts registry"
        status: pending
      - id: "PROJ-124"
        title: "Add shortcuts UI"
        status: pending
```

Update issue status as work progresses:
- `pending` → `spec` → `implementing` → `validating` → `done`

### Record Errors

When something fails:

```yaml
errors:
  - phase: implement
    issue: "PROJ-123"
    timestamp: {ISO timestamp}
    message: "Type check failed"
    details: |
      Error output here
```

### Resume Session

To resume, read the session file and:

1. Check `current_phase` — where we left off
2. Check `current_issue` — which issue we were on
3. Check phase statuses — what's approved vs pending
4. Continue from that point

### Complete Session

When all work is done:

```yaml
status: completed
completed_at: {ISO timestamp}
```

### Abandon Session

If user cancels:

```yaml
status: abandoned
abandoned_at: {ISO timestamp}
reason: "User cancelled"
```

## Reading State

Agents should read session state at the start to understand context:

```
1. Check if session file exists
2. If yes, parse YAML and understand current position
3. If no, this is a fresh start
```

## Writing State

After every significant action:

1. Read current state
2. Update relevant fields
3. Update `updated` timestamp
4. Write back to file

## Session Recovery

If a session was interrupted:

1. User runs `/develop --resume` or `/develop --resume {session-id}`
2. Find most recent `in_progress` session (or specified ID)
3. Load state and continue from `current_phase`

## List Sessions

```bash
ls -la .claude/sessions/*.yml
```

Or parse programmatically to show user their sessions.
