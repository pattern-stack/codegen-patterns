# ADR-030 — Progressive Disclosure for Project Skills

**Status:** Accepted
**Date:** 2026-04-18
**Owner:** Doug
**Related:** ADR-008 (Subsystem Architecture)

## Context

`codegen-patterns` is growing in surface area: the jobs subsystem alone now has one ADR (ADR-022) plus eight implementation specs (JOB-1 through JOB-8). The events codegen formalization adds another design doc with its own emerging spec set. Future domains (Event-to-Job Bridge ADR-023, coordination ADR-025, JobEvent observability ADR-026, agent extensions ADR-027) will follow the same shape.

The question is not whether to document — the docs exist and are necessary. The question is **what context an agent loads when working in this repo**.

Two failure modes to avoid:

1. **Underloading.** An agent works on a `@JobHandler` class without knowing that reserved `events_*` pools cannot be targeted, that `parent_close_policy` defaults to `Terminate`, that step memoization happens via `ctx.step` and not by re-running the whole handler. Agent produces code that looks plausible and is wrong. ADR-022 contains the answers, but the agent did not read it because nothing told them to.

2. **Overloading.** Every agent loads ADR-022, JOB-1 through JOB-8, the events plan, the dealbrain audit, and every adjacent spec "just in case." Agents working on entity templates pay context cost for jobs detail they will never use. Cache hit rate drops; responses slow; reasoning gets diluted.

The prior practice in this repo was **flat skills**: one `SKILL.md` per domain (`codegen/`, `browser/`, `code-review/`, etc.) holding the entire body of knowledge. This works at small surface area. It does not scale to a domain with one ADR + eight specs.

The `pattern-stack` plugin, audited at `/Users/dug/Projects/dev/pattern-stack`, demonstrates a working alternative: **L0/L1 progressive disclosure**. One `SKILL.md` per domain (~150 lines, auto-loaded as the router) plus sibling L1 files (200–335 lines each, loaded only when the agent's task routes there). The audit (`docs/specs/pattern-stack-disclosure-audit.md`) details the mechanics.

Pattern-stack's implementation skips frontmatter on its skill files and relies on prescriptive routing in agent system prompts. This works in pattern-stack's plugin context but throws away three things the standard Claude Code skill frontmatter provides at zero cost: harness-level skill discovery via `description`, tool restriction via `allowed-tools`, and explicit `user-invocable: false` to prevent accidental slash-command exposure.

## Decision

### Two skill shapes — choose deliberately

**Flat (single-file).** One `SKILL.md`, no siblings. Used when the entire body fits comfortably under ~250 lines without losing structure. Cost of progressive disclosure (extra files, routing table maintenance) outweighs context savings. Existing skills (`codegen`, `browser`, `code-review`, `dev-companion`, `project-documentation`, `run-and-monitor`, `skill-authoring`) stay flat.

**Progressive disclosure (L0 + L1).** `SKILL.md` is a router (≤250 lines: mental model, non-obvious rules, routing table). Sibling L1 files (100–300 lines each) carry deep dives, loaded only when the agent's task routes to them. Used when the domain has multiple sub-concerns that don't all apply to every task.

The first two progressive-disclosure skills in this project — `jobs` and `events` — serve as the template for future complex domains.

### Frontmatter is required on every skill (both shapes)

Standard Claude Code skill frontmatter, on every `SKILL.md`:

```yaml
---
name: <skill-name>
description: <one paragraph — when an agent should load this skill, with specific triggers>
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
user-invocable: false
---
```

L1 sibling files do not have frontmatter — they are loaded by reference from L0's routing table, not by independent discovery.

### L0 structure (locked)

1. One-paragraph what-is-this overview
2. Mental model — concrete enough to reason without opening L1, not so detailed L1 becomes redundant
3. Routing table — explicit "for X, read `<file>.md`"
4. Non-obvious rules — the things an agent MUST internalize before writing code in this domain
5. Do-not list — anti-patterns and dead paths (especially rejected alternatives that may seem appealing)

Length target: 150–250 lines. Past 300 lines, push detail into L1.

### Authoring rule

A skill is best authored by an agent who has **just learned** the domain — fresh enough to remember what was confusing, structured enough to organize it. Agents deeply rooted in a domain through a long conversation suffer curse-of-knowledge bias and produce skills that under-explain. When a skill needs to be written or rewritten, prefer spawning a fresh agent with the relevant ADRs and specs as input over having the long-conversation agent author it directly. The deep-context agent reviews for technical accuracy after.

## Consequences

**Positive:**

- Agents working on a domain load focused, sufficient context. Agents working elsewhere are unburdened.
- Frontmatter `description` enables harness-level skill discovery — agents find the right skill from the task alone, no manual routing required.
- `allowed-tools` prevents accidental capability surface (a doc-only skill cannot edit code).
- Routing tables in L0 make the skill's structure self-documenting; future contributors see what L1 files exist and what each covers.
- Establishes a reusable template. Future domains follow the same shape; the cognitive overhead is paid once.

**Negative:**

- Two shapes mean a contributor must choose which to use. The choice is usually obvious (line count) but not always.
- L0 routing tables drift if maintained sloppily. A new L1 file added without updating L0 is invisible. Mitigation: code review.
- Progressive disclosure has overhead for tiny domains. The flat-vs.-progressive decision must be made deliberately, not defaulted.
- Frontmatter `description` is what the harness uses for discovery. A vague description means the skill is not loaded when it should be. This requires care at authoring time.

## Alternatives considered

1. **Status quo: flat skills only.** Rejected: jobs domain alone produces ~3000 lines of spec content (eight specs at ~400 lines each). A flat skill either omits 80% of it (losing fidelity) or includes everything (defeating the discovery purpose). Progressive disclosure exists for exactly this scale.

2. **No frontmatter (pattern-stack's choice).** Rejected: frontmatter costs nothing and gains harness-level discovery, tool restriction, and slash-command gating. Pattern-stack's omission appears to be incidental — their plugin model uses prescriptive routing in agent prompts, which is a different mechanism we don't have here. We preserve their L0/L1 structural insight while adding the standard frontmatter the broader Claude Code ecosystem uses.

3. **Pure prescriptive routing (no frontmatter, agents told what to read in their system prompts).** Rejected: requires every agent definition to know about every skill. Frontmatter centralizes the routing rule with the skill itself, which scales as skills accumulate.

4. **Single mega-skill per project.** Rejected: a single 5000-line `SKILL.md` covering jobs + events + entities + templates + everything else is the worst of both worlds — no discovery, full context cost on every load.

## Migration

**No migration of existing flat skills.** They work; flat is correct for their size. If a flat skill grows past ~250 lines and the structure starts to suffer, convert to progressive at that point.

**New domains use progressive.** When a new complex domain emerges (the Event-to-Job Bridge in ADR-023, coordination in ADR-025, etc.), the convention is: new domain → new directory under `.claude/skills/` → progressive structure → frontmatter.

**`CLAUDE.md` does not enumerate domains.** The `description` field on each skill carries the discovery information. Adding a new skill does not require a CLAUDE.md edit.

## References

- `docs/specs/pattern-stack-disclosure-audit.md` — the audit that informed this design
- `.claude/skills/README.md` — quick-reference convention summary for contributors
- `.claude/skills/jobs/` — first progressive-disclosure skill in this project. L0 `SKILL.md` (177 lines) routes to three L1 files: `handler-authoring.md` (209 lines), `orchestrator-and-worker.md` (237 lines), `pools-and-config.md` (215 lines). Total 838 lines split across four files — agents working on a handler load only L0 + `handler-authoring.md` (~390 lines), not the full domain.
- `.claude/skills/events/` — second progressive-disclosure skill. L0 `SKILL.md` (96 lines) routes to four L1 files: `outbox-and-transactions.md` (139 lines), `event-codegen.md` (285 lines), `directions-and-pools.md` (113 lines), `protocol-and-backends.md` (161 lines). Total 794 lines split across five files. The largest L1 (`event-codegen.md`) is the in-flight design — agents touching the typed event facade load it; agents only publishing existing events do not.

These two are the **template-setting v1** of progressive disclosure for codegen-patterns. They demonstrate both the frontmatter convention and the L0/L1 split, and serve as the reference shape for future complex domains.
- `~/.claude/plugins/cache/claude-brain/claude-brain/1.0.0/skills/skill-authoring/SKILL.md` — standard Claude Code frontmatter reference
