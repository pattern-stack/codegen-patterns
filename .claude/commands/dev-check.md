---
description: Run a full dev environment health check — services, app, endpoints, browser verification
argument-hint: [--skip-browser]
allowed-tools: Read, Bash, Glob, Grep
---

# /dev-check

Run a comprehensive health check on the dev environment. Reports structured pass/fail for every layer.

## Procedure

### 1. Check Docker services

```bash
# Postgres
docker exec codegen-dev-postgres pg_isready -U postgres -d codegen_dev

# Redis
docker exec codegen-dev-redis redis-cli ping
```

Record pass/fail for each.

### 2. Check app health

```bash
# HTTP check
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/

# PID check
cat .dev-app.pid 2>/dev/null && kill -0 $(cat .dev-app.pid) 2>/dev/null
```

### 3. Check entity endpoints

For each entity YAML in `entities/`, derive the plural endpoint name and check it:

```bash
# List entities
ls entities/*.yaml | sed 's|entities/||; s|\.yaml||'

# For each entity, check its endpoint
curl -s -w '\n%{http_code}' http://localhost:3000/<plural>
```

Record the HTTP status code for each.

### 4. Browser verification (optional)

If `--skip-browser` was NOT passed, attempt to spawn the browser-pilot teammate for deeper verification:

Try to use the Agent tool to spawn a teammate:
```
Spawn a browser-pilot teammate to verify the following endpoints return valid JSON responses:
- http://localhost:3000/accounts
- http://localhost:3000/contacts
- http://localhost:3000/opportunities
- http://localhost:3000/activities

Check for console errors and network failures. Report pass/fail for each.
```

**Fallback**: If teammate spawning is not available (no Agent tool, or teammate mode disabled), fall back to curl-based verification:

```bash
# Verify response is valid JSON
curl -s http://localhost:3000/accounts | head -c 500
curl -s http://localhost:3000/contacts | head -c 500
```

### 5. Report

Present results in this format:

```
## Dev Environment Health Check

### Services
| Service  | Status  | Details |
|----------|---------|---------|
| Postgres | PASS/FAIL | pg_isready result |
| Redis    | PASS/FAIL | ping result |
| App      | PASS/FAIL | HTTP status, PID |

### Endpoints
| Endpoint       | Status | Code |
|----------------|--------|------|
| GET /accounts  | PASS   | 200  |
| GET /contacts  | PASS   | 200  |
| ...            | ...    | ...  |

### Browser Verification
| Check          | Result |
|----------------|--------|
| Console errors | none / N errors |
| Network fails  | none / N failures |
| JSON valid     | yes / no |

### Summary
X/Y checks passed.
```

## When Services Are Down

If Docker services are not running, suggest:
```
Services are not running. Start them with:
  codegen dev up
```

Do not attempt to start services automatically — just report and suggest.
