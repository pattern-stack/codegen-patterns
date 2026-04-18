# Skills

This directory holds Claude Code skills for the `codegen-patterns` project. Skills are auto-discovered by the harness and loaded into agent context when relevant.

## Two skill shapes — pick the right one

This project supports **two skill organizations**. They are not equivalent; pick deliberately.

### Shape A — Flat (single-file)

One `SKILL.md` containing the entire body of knowledge. No siblings.

**Use when:** the domain is narrow and the entire skill comfortably fits under ~250 lines without losing structure. The cost of progressive disclosure (extra files, a routing table) outweighs the context savings.

**Examples in this project:**
- `codegen/` — CLI command reference; tight, single concept
- `browser/`, `code-review/`, `dev-companion/`, `project-documentation/`, `run-and-monitor/`, `skill-authoring/` — narrow tools or workflows
- `jobs/`, `events/` — domain skills authored 2026-04-18. Currently flat (177 and 96 lines respectively); cross the 300-line threshold and they split into L1.

### Shape B — Progressive disclosure (L0 + L1)

`SKILL.md` is a **router** (≤250 lines): mental model, non-obvious rules, and a routing table pointing at sibling L1 files. L1 files contain deep dives loaded only when the agent's task routes there.

**Use when:** the domain has multiple sub-concerns that don't all apply to every task. Loading the full body for an agent who only needs one slice wastes context.

**Examples in this project:**
- `jobs/` — L0 `SKILL.md` (177 lines) routes to four L1 files: `handler-authoring.md`, `orchestrator-and-worker.md`, `pools-and-config.md`, `phase-roadmap.md`
- `events/` — L0 `SKILL.md` (96 lines) routes to four L1 files: `outbox-and-transactions.md`, `event-codegen.md`, `directions-and-pools.md`, `protocol-and-backends.md`

Both authored 2026-04-18 as the **template-setting v1** of progressive disclosure in this project. Future complex domains follow this shape.

## Convention (locked, see ADR-030)

### Every skill (both shapes) MUST have frontmatter

```yaml
---
name: <skill-name>           # matches directory name
description: <one paragraph — when an agent should load this skill, with specific triggers>
allowed-tools: Read, Write, Edit, Glob, Grep, Bash    # restrict where appropriate
user-invocable: false        # true only if `/<name>` should be a slash command
---
```

The `description` field is what the harness shows the LLM during skill discovery. Be concrete about *when* to load the skill, not *what* it contains. ("Use when working on @JobHandler classes" is better than "About jobs.")

### L1 files do NOT have frontmatter

L1 files are pulled in by reference from L0's routing table. They are not independently discoverable; they don't need it.

### L0 (`SKILL.md`) structure

1. **One-paragraph what-is-this.**
2. **Mental model** — concrete enough to reason without opening L1, not so detailed that L1 becomes redundant.
3. **Routing table** — explicit "for X, read `<file>.md`."
4. **Non-obvious rules** — the things an agent MUST internalize (state machine values, reserved-pool rules, anti-patterns).
5. **Do-not list** — anti-patterns and dead paths (rejected alternatives that may seem appealing).

Length target: 150–250 lines. If you're past 300, push detail into L1.

### L1 files

Topical, focused, 100–300 lines each. No frontmatter. Cross-reference back to ADRs and specs (`docs/adrs/`, `docs/specs/`) instead of duplicating.

## Discovery and loading

- **CLAUDE.md** is auto-loaded into every agent context. It is the unconditional surface — keep it tight; let skills carry domain detail.
- **Skill `description`** drives discovery: when an agent's task matches the description, the harness offers the skill.
- **L1 files** are loaded by the agent reading them after L0's routing table directs it. Not auto-discovered.

## Adding a new domain

1. Decide flat vs. progressive (use the criteria above).
2. Create `<domain>/SKILL.md` with full frontmatter.
3. If progressive: create L1 sibling files; populate the routing table in L0.
4. Don't update `CLAUDE.md` to describe the new domain — let the skill's `description` do that work.
5. Read ADR-030 if you're unsure why this convention exists.

## See also

- `docs/adrs/ADR-030-progressive-disclosure-skills.md` — the full architectural decision and rationale
- `docs/specs/pattern-stack-disclosure-audit.md` — the audit that informed this design
- `~/.claude/plugins/cache/claude-brain/.../skill-authoring/SKILL.md` — frontmatter convention reference
