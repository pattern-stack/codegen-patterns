---
name: project-documentation
description: codegen-patterns documentation conventions — where ADRs, RFCs, specs, and guides live, how they're named, and the status taxonomy. Use when writing an ADR or RFC, creating a spec (JOB-N style), marking a spec shipped or superseded, or deciding where a doc belongs.
allowed-tools: Read, Write, Edit, Glob, Grep
user-invocable: true
---

# Project Documentation (codegen-patterns overlay)

Project-specific facts for THIS repo. The generic discipline — detect conventions before creating, append-only ADRs, status-in-place, post-implementation truth — lives in the sdlc plugin's `sdlc:project-documentation` skill. This overlay records the conventions that can't be detected reliably.

## The documentation estate

| Where | What | Naming |
|---|---|---|
| `docs/adrs/` | Architecture Decision Records | `ADR-NNN-kebab-title.md` (3-digit; dotted sub-ADRs like `ADR-033.1-…` amend a parent decision) |
| `docs/rfcs/` | RFCs — design arcs spanning multiple ADRs/specs | `RFC-NNNN-kebab-title.md` (4-digit) |
| `docs/specs/` | Implementation specs | `<SPEC-KEY>.md` — uppercase family key + ordinal: `JOB-1.md`, `BRIDGE-2.md`, `EVT-5.md`, `ACTIVITY-SUBJECT-1.md` |
| `docs/guides/`, `docs/consumer/`, `docs/handoffs/` | Guides, consumer-facing docs, session handoffs | freeform |
| `.ai-docs/` | SDLC working artifacts (plans, stacks, handoff.md) | governed by the sdlc plugin's `artifact_paths` — not this skill |
| `ai-docs/` | **Legacy** agent docs (pre-`.ai-docs` migration) | do not add new files here |

## Header style

Bold-field header block, NOT YAML frontmatter:

```markdown
# ADR-037 — Runtime Mode (`package` | `vendored`) + Namespaced `Symbol.for` Tokens

**Status:** Accepted
**Date:** 2026-06-01
**Owner:** Doug
**Related:** ADR-008, ADR-036, RFC-0001
```

Specs add `**Issue:**` / `**Depends on:**` / `**Phase:**` fields where they apply.

## Status taxonomy (as practiced)

- **ADRs:** `Draft → Accepted → Superseded by ADR-NNN | RFC-NNNN` — append-only; ADRs can be superseded by RFCs.
- **Specs:** `Stub → Draft → Implemented | Shipped → Superseded by …`. `Shipped` lines cite the evidence: `**Status:** Shipped 2026-04-22 via PRs #183 (OPENAPI-1), #185 (OPENAPI-2)`.

## Rules

1. **Never archive or move.** Terminal specs stay in `docs/specs/` with status updated in place — the domain skills (`jobs`, `events`, `bridge`, …) route to specs by path ("ADR-022 or JOB-1..JOB-8 specs"); moving files breaks their routing tables.
2. **Specs are post-implementation truth** (CLAUDE.md › Operating Principles): when an implementation lands, update the spec in the same PR — close resolved open questions, correct details that turned out wrong, record constraints discovered while building.
3. **Spec keys come from the parent decision:** ADR-022 → `JOB-N`, ADR-023 → `BRIDGE-N`, ADR-024 → `EVT-N`. Starting a new family? Mint a short uppercase key in the parent ADR/RFC.
4. **Check ADR number collisions before minting.** Two ADR-031s already exist — `Glob docs/adrs/*` and verify the number is free; don't add a third.
5. **Altitude:** ADRs capture *why*; RFCs capture multi-spec *design arcs*; specs capture *how*, one PR-sized unit each.
6. **Don't over-document.** If it's in the code or git history, don't repeat it in docs.
