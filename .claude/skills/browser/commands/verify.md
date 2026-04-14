---
description: Run visual QA on a URL — screenshot, console, network, performance
argument-hint: [url] [--perf]
---

# /verify — Visual QA

Run a visual QA pass against a URL using Chrome DevTools Protocol.

## Usage

```
/verify                     # Verify localhost:3000 (default)
/verify http://localhost:3000/health   # Verify a specific URL
/verify --perf              # Include performance trace
/verify http://localhost:3000 --perf   # Both
```

**Arguments**:
- `$ARGUMENTS`: Target URL (defaults to `http://localhost:3000` if omitted). Append `--perf` for performance metrics.

## Steps

### 1. Check CDP Connection

Call `mcp__chrome-devtools__list_pages` to verify the browser is reachable.

**If connection fails**: Follow the CDP Connection Check in the parent skill — read `BROWSER_PREFERENCE` from `.claude/settings.local.json` env and show their specific launch command. Stop here.

### 2. Navigate

If the target URL differs from the currently selected page, use `mcp__chrome-devtools__navigate_page`.

### 3. Visual QA Pass

Run in parallel where possible:

1. **Snapshot**: `mcp__chrome-devtools__take_snapshot` — accessibility tree
2. **Console**: `mcp__chrome-devtools__list_console_messages` — errors and warnings
3. **Network**: `mcp__chrome-devtools__list_network_requests` — failed requests (filter for non-200s)
4. **Screenshot**: `mcp__chrome-devtools__take_screenshot` — save to `screenshots/verify-{timestamp}.png`, then read it

### 4. Report

Use the reporting format from the parent skill:

```
**Page:** {url}
**Status:** {pass | issues found}

**Console:** {N errors, M warnings} or "clean"
**Network:** {N failed requests} or "all OK"
**Visual:** {brief description of what's on screen}

{Details of any issues found}
```

### 5. Performance (if --perf)

If `--perf` is in the arguments:

1. Run `mcp__chrome-devtools__performance_start_trace` with `reload: true`, `autoStop: true`
2. Report metrics:

```
**Performance:**
| Metric | Value |
|--------|-------|
| LCP | {ms} |
| CLS | {score} |
| TTFB | {ms} |
```

3. List any available insight names for follow-up

## Tips

- For repeated checks, just re-run `/verify` — reuses the existing CDP connection
- Use `mcp__chrome-devtools__performance_analyze_insight` for deep dives after a perf trace
