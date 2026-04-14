---
description: Guide for enabling Claude Code teammate mode for multi-agent dev workflows
allowed-tools: Read, Bash, Glob, Grep
---

# /teammate-setup

Walk the user through enabling teammate mode in Claude Code so that commands like `/dev-check`, `/dev-test`, and `/dev-debug` can spawn specialized agents (like browser-pilot) for deeper verification.

## What is Teammate Mode?

Teammate mode allows Claude Code to spawn additional specialized agents that run concurrently. Each teammate has its own tools, MCP servers, and context. For example, browser-pilot can run a headless browser to verify endpoints while the main agent continues working.

## Check Current Status

First, check the current Claude Code configuration:

```bash
cat .claude/settings.json 2>/dev/null
cat .claude/settings.local.json 2>/dev/null
```

Look for:
- `permissions.allow` array (should include relevant tools)
- Any existing teammate/agent configuration

## Existing Agents

This project already has agents defined in `.claude/agents/`:

```bash
ls .claude/agents/
ls .claude/agents/team/
```

Key agents for dev companion:
- **browser-pilot.md** — navigates and inspects the app via headless browser
- **team/validator.md** — runs validation gates

## Setup Steps

### 1. Verify Claude Code Version

Teammate mode requires a recent version of Claude Code. The user should be on the latest version:

```
claude --version
```

### 2. Enable Agent Permissions

The `.claude/settings.json` should allow the necessary tools. Check if it already does:

```bash
cat .claude/settings.json
```

If the Agent tool is not in the allow list, inform the user they need to add it. Do NOT modify settings.json directly — instead, tell the user:

```
To enable teammate spawning, add "Agent" to your permissions.allow in .claude/settings.json:

{
  "permissions": {
    "allow": [
      ...existing entries...,
      "Agent"
    ]
  }
}
```

### 3. Verify MCP Servers

Browser-pilot needs MCP servers (chrome-devtools, playwright, lighthouse). These are defined in the agent file itself — no additional setup needed. But the user needs the npm packages available:

```bash
# These are installed on-demand via npx, but verify npx works:
npx --version
```

### 4. Test Teammate Spawning

Tell the user to test with a simple command:

```
Try running /dev-check in Claude Code. If it successfully spawns a browser-pilot teammate for endpoint verification, teammate mode is working.

If you see a fallback message saying "teammate mode not available", check:
1. Your Claude Code version supports teammates
2. The Agent tool is in your permissions
3. Your plan/subscription supports concurrent agents
```

## Fallback Behavior

All dev companion commands are designed to work without teammate mode:
- `/dev-check` falls back to curl-based endpoint verification
- `/dev-test` falls back to curl-based JSON validation
- `/dev-debug` falls back to log-based debugging without browser inspection

Teammate mode enhances these commands with browser-based verification but is not required.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Agent tool not available" | Add "Agent" to `.claude/settings.json` permissions |
| "Cannot spawn teammate" | Check Claude Code version and plan limits |
| Browser-pilot can't connect | Ensure Chrome remote debugging is enabled for chrome-devtools, or use playwright (headless) |
| MCP server fails | Run `npx @playwright/mcp@latest --help` to verify playwright MCP is installable |

## Report

After checking, tell the user:
1. Whether teammate mode appears to be available
2. What changes (if any) are needed
3. Which commands will benefit from teammate mode
4. That all commands work in fallback mode regardless
