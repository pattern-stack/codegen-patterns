---
description: Run unit tests, smoke tests, and live endpoint verification
argument-hint: [--unit-only]
allowed-tools: Read, Bash, Glob, Grep
---

# /dev-test

Run the full test suite and verify live endpoints if the dev environment is up.

## Procedure

### 1. Unit tests

Always run unit tests first:

```bash
cd /Users/dug/Projects/agents/codegen-patterns
just test-unit
```

Record pass/fail and test count.

### 2. Baseline tests

Run baseline snapshot tests:

```bash
cd /Users/dug/Projects/agents/codegen-patterns
just test-baseline
```

Record pass/fail.

### 3. Live endpoint tests (if dev is up)

Check if Docker services are running:

```bash
docker exec codegen-dev-postgres pg_isready -U postgres 2>/dev/null
```

If services are up, check the app:

```bash
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/
```

If the app is responding, run endpoint checks:

```bash
# For each entity in entities/
for entity in $(ls entities/*.yaml 2>/dev/null | sed 's|entities/||; s|\.yaml||'); do
  # Derive plural (simple heuristic)
  curl -s -w '\nHTTP_CODE:%{http_code}\n' "http://localhost:3000/${entity}s"
done
```

### 4. Browser verification (if dev is up)

Attempt to spawn a browser-pilot teammate for deeper endpoint verification:

```
Verify each endpoint at http://localhost:3000 returns valid JSON:
- Check response Content-Type is application/json
- Check response body parses as valid JSON
- Check no console errors
- Check no failed network requests
```

**Fallback**: If teammate mode is unavailable, use curl to validate JSON responses:

```bash
curl -s http://localhost:3000/accounts | python3 -m json.tool > /dev/null 2>&1 && echo "PASS" || echo "FAIL"
```

### 5. Report

Present aggregate results:

```
## Test Results

### Unit Tests
Status: PASS/FAIL
Tests: X passed, Y failed, Z total
Duration: Ns

### Baseline Tests
Status: PASS/FAIL

### Live Endpoint Tests
Status: PASS/FAIL/SKIPPED (dev not running)

| Endpoint       | HTTP | JSON Valid |
|----------------|------|------------|
| GET /accounts  | 200  | yes        |
| GET /contacts  | 200  | yes        |

### Browser Verification
Status: PASS/FAIL/SKIPPED (teammate not available)

### Summary
X/Y test suites passed.
```

## Quick Mode

If `--unit-only` is passed in $ARGUMENTS, only run unit tests and skip everything else.
