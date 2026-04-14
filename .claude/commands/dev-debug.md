---
description: Debug the running dev environment — read logs, check errors, suggest fixes
argument-hint: [error-description]
allowed-tools: Read, Bash, Glob, Grep
---

# /dev-debug

Investigate issues in the running dev environment. Reads logs, checks service health, inspects errors, and suggests fixes.

## Procedure

### 1. Gather context

If the user provided an error description in $ARGUMENTS, note it for targeted investigation.

### 2. Check service health

```bash
# Docker services
docker exec codegen-dev-postgres pg_isready -U postgres 2>/dev/null
docker exec codegen-dev-redis redis-cli ping 2>/dev/null

# App process
cat .dev-app.pid 2>/dev/null
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null
```

### 3. Read recent app logs

```bash
# Last 100 lines of app log
tail -100 .dev-app.log 2>/dev/null
```

Look for:
- Unhandled exceptions
- Connection refused errors
- Module initialization failures
- TypeScript compilation errors
- Missing dependency errors

### 4. Check Docker logs

```bash
docker logs codegen-dev-postgres --tail 50 2>/dev/null
docker logs codegen-dev-redis --tail 50 2>/dev/null
```

Look for:
- Authentication failures
- Connection limit errors
- OOM kills
- Crash loops

### 5. Check port conflicts

```bash
lsof -i :3000 2>/dev/null
lsof -i :5433 2>/dev/null
lsof -i :6380 2>/dev/null
```

### 6. Browser verification (if app is responding)

If the app is responding on port 3000, attempt to spawn browser-pilot for deeper inspection:

```
Navigate to http://localhost:3000/ and check:
1. Console errors (list all)
2. Network failures (list failed requests)
3. Response status codes
Report findings.
```

**Fallback**: If teammate mode is unavailable, check via curl:

```bash
# Check each known endpoint for error responses
curl -s http://localhost:3000/accounts 2>&1 | head -20
curl -s http://localhost:3000/contacts 2>&1 | head -20
```

### 7. Diagnose and suggest

Based on findings, provide:

1. **Root cause**: What's actually broken
2. **Fix**: Specific commands to run
3. **Prevention**: How to avoid this in the future

Common fixes:

| Symptom | Fix |
|---------|-----|
| App won't start | Check `.dev-app.log` for the error, fix code, `codegen dev restart` |
| DB connection refused | `codegen dev down && codegen dev up` |
| Port in use | `kill $(lsof -t -i :3000)` then `codegen dev restart` |
| Schema mismatch | `DATABASE_URL="..." bunx drizzle-kit push` |
| Missing module | Check NestJS module imports in `src/app.module.ts` |
| Redis connection failed | `docker restart codegen-dev-redis` |

### 8. Report

```
## Debug Report

### Service Health
| Service  | Status | Details |
|----------|--------|---------|
| Postgres | ...    | ...     |
| Redis    | ...    | ...     |
| App      | ...    | ...     |

### Issues Found
1. **[severity]** description
   - Root cause: ...
   - Fix: `command to run`

### Logs (relevant excerpts)
```
relevant log lines
```

### Suggested Actions
1. `command` — what it does
2. `command` — what it does
```
