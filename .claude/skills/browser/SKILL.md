---
name: browser
description: Browser interaction via Chrome DevTools Protocol. Auto-invoked when the conversation mentions browser verification, console errors, screenshots, lighthouse audits, visual QA, or checking the app in a browser. Also exposes /verify and /browse commands.
allowed-tools: Bash, Read, Glob, Grep
---

# Browser

## Purpose

Unified browser interaction skill for development — see the user's browser, interact with pages, run visual QA, and audit performance. Works with any Chromium-based browser via CDP.

## Browser Compatibility

Connects via Chrome DevTools Protocol (CDP) on port 9222. Works with **any Chromium-based browser**. Does NOT work with Firefox or Safari.

### Supported Browsers

| Browser | macOS Launch Command |
|---------|---------------------|
| Arc | `open -a "Arc" --args --remote-debugging-port=9222` |
| Chrome | `open -a "Google Chrome" --args --remote-debugging-port=9222` |
| Chromium | `open -a "Chromium" --args --remote-debugging-port=9222` |
| Brave | `open -a "Brave Browser" --args --remote-debugging-port=9222` |
| Edge | `open -a "Microsoft Edge" --args --remote-debugging-port=9222` |
| Vivaldi | `open -a "Vivaldi" --args --remote-debugging-port=9222` |
| Opera | `open -a "Opera" --args --remote-debugging-port=9222` |

> Quit the browser first, then relaunch with the command above to enable remote debugging.

### Per-Dev Browser Preference

Each dev's preferred browser is stored as an env var in `.claude/settings.local.json` (gitignored, never committed):

```json
{
  "env": {
    "BROWSER_PREFERENCE": "arc"
  }
}
```

Valid values: `arc`, `chrome`, `chromium`, `brave`, `edge`, `vivaldi`, `opera`.

When CDP connection fails:
1. Read `BROWSER_PREFERENCE` from `settings.local.json`
2. If the env var is not set, **ask the user which browser they use** and set it for them by editing `settings.local.json`
3. Show the launch command for their specific browser

## Three MCP Servers

| Server | Purpose | When to Use |
|--------|---------|-------------|
| `chrome-devtools` | User's browser | See what they see, use their session/cookies, interact with their page |
| `playwright` | Headless browser | Independent verification, automated checks, don't disturb user |
| `lighthouse` | Auditing | Performance, accessibility, SEO, best practices |

## Key Tool Preferences

- **PREFER** `take_snapshot` / `browser_snapshot` (accessibility tree) over screenshots — structured, token-efficient
- **USE** `chrome-devtools` when you need the user's session state or to interact with their browser
- **USE** `playwright` for independent headless verification
- **USE** `lighthouse` for quality gates on performance/a11y

## Project URLs

| Endpoint | URL |
|----------|-----|
| Backend API | `http://localhost:3000` |
| Health check | `http://localhost:3000/health` |

Note: This is a CLI/codegen project. There is no frontend dev server by default. The backend runs NestJS.

## Commands

This skill exposes two user-invocable commands:

- **`/verify [url]`** — Run a visual QA pass (snapshot, console, network, screenshot, optional perf)
- **`/browse [instruction]`** — Open-ended browser interaction as the dev directs

See `commands/verify.md` and `commands/browse.md` for details.

## Spawning the Browser-Pilot Teammate

For delegated browser work (e.g., during `/develop` loops), spawn the browser-pilot agent:

```
Agent tool with subagent_type="browser-pilot", name="browser-pilot"
```

The agent (`.claude/agents/browser-pilot.md`) runs on Sonnet with its own MCP server connections and uses this skill as its knowledge base.

## CDP Connection Check

Before any browser interaction, verify CDP is reachable:

1. Call `mcp__chrome-devtools__list_pages`
2. **If it works** — proceed with the interaction
3. **If it fails**:
   - Read `.claude/settings.local.json` to check for `BROWSER_PREFERENCE` in `env`
   - **If not set**: ask the user which Chromium browser they use, then edit `settings.local.json` to add it under `env`
   - Show the specific launch command from the table above for their browser
   - Tell them to quit the browser first, then relaunch with the flag
   - Stop and wait — do not proceed until CDP is connected

## Reporting Format

When reporting browser state, use this structure:

```
**Page:** {url}
**Status:** {pass | issues found}

**Console:** {N errors, M warnings} or "clean"
**Network:** {N failed requests} or "all OK"
**Visual:** {brief description of what's on screen}

{Details of any issues found}
```

## Screenshot Settings

- Default viewport: **1280x720**
- Save to: `screenshots/` at project root
- Session subfolder: `screenshots/{YYYY-MM-DD}-{short-description}/`
- File naming: `{NN}-{what-is-shown}.png` (zero-padded sequence)
- ALWAYS resize viewport to 1280x720 before taking screenshots (Playwright starts smaller)
