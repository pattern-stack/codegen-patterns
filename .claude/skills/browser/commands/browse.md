---
description: Interact with the user's browser — navigate, click, type, inspect, or anything else
argument-hint: [instruction...]
---

# /browse — Browser Interaction

Open-ended browser interaction. Tell Claude what to do in your browser and it will do it.

## Usage

```
/browse go to localhost:3000 and check the API response
/browse check if the health endpoint returns 200
/browse take a screenshot of the current page
/browse what's on my screen right now?
/browse run a lighthouse accessibility audit on localhost:3000
```

**Arguments**:
- `$ARGUMENTS`: Natural language instruction describing what to do in the browser.

## How It Works

### 1. Check CDP Connection

Call `mcp__chrome-devtools__list_pages` to verify the browser is reachable.

**If connection fails**: Follow the CDP Connection Check in the parent skill — read `BROWSER_PREFERENCE` from `.claude/settings.local.json` env and show their specific launch command. Stop here.

### 2. Interpret and Execute

Read the user's instruction and determine which tools to use. You have the full toolkit:

**Navigation & Interaction** (chrome-devtools):
- `navigate_page` — go to a URL
- `click` — click an element (use uid from snapshot)
- `fill` — type into an input
- `fill_form` — fill multiple fields at once
- `hover` — hover over an element
- `type_text` — type with optional submit key
- `press_key` — press a key
- `drag` — drag an element
- `upload_file` — upload a file to an input

**Inspection** (chrome-devtools):
- `take_snapshot` — accessibility tree (preferred for understanding page structure)
- `take_screenshot` — visual capture
- `list_console_messages` — console output
- `list_network_requests` — network activity
- `evaluate_script` — run JS in page context
- `get_console_message` — details on a specific message
- `get_network_request` — details on a specific request

**Performance** (chrome-devtools):
- `performance_start_trace` / `performance_stop_trace` — capture traces
- `performance_analyze_insight` — deep dive on specific metrics

**Headless** (playwright — for independent checks):
- `browser_navigate`, `browser_click`, `browser_snapshot`, `browser_take_screenshot`
- `browser_evaluate`, `browser_console_messages`, `browser_network_requests`

**Auditing** (lighthouse):
- `run_audit` — full Lighthouse audit
- `get_performance_score`, `get_accessibility_score`, `get_seo_analysis`
- `get_core_web_vitals`, `get_lcp_opportunities`
- `compare_mobile_desktop`, `find_unused_javascript`

### 3. Report Back

After completing the instruction:
- Describe what happened
- Show screenshots if visual output was requested or relevant
- Report any errors encountered
- Suggest follow-up actions if appropriate

## Approach

- **Always snapshot first** to understand page structure before interacting
- **Use element uids** from the snapshot for clicks and fills — never guess coordinates
- **Chain actions naturally** — if the user says "click X then fill Y", do both
- **Be conversational** — this is interactive, not a formal report. Match the user's tone.
- **Ask if unclear** — if the instruction is ambiguous, ask before acting
