# Browser Skill

Browser interaction via Chrome DevTools Protocol, Playwright, and Lighthouse.

## Components

- `SKILL.md` — Main skill definition (auto-invoked by Claude)
- `commands/browse.md` — `/browse` command for open-ended browser interaction
- `commands/verify.md` — `/verify` command for visual QA passes

## MCP Servers Required

This skill requires three MCP servers (configured on the `browser-pilot` agent):

1. **chrome-devtools** — Connect to user's browser via CDP
2. **playwright** — Headless browser for independent verification
3. **lighthouse** — Performance and accessibility auditing

## Usage

The skill is auto-invoked when conversations mention browser verification, screenshots, console errors, or visual QA. It can also be used via the `/browse` and `/verify` commands.

For delegated work, spawn the `browser-pilot` agent which has the MCP servers configured.
