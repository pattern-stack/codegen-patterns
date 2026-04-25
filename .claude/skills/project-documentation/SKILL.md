---
name: project-documentation
description: Create and manage project documentation — ADRs, specs, and architecture docs. Use when the user wants to write an ADR, create a spec, archive a completed spec, or discuss documentation structure.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Project Documentation

## Purpose

Standardize creation and management of project documentation: Architecture Decision Records (ADRs), implementation specs, and the architecture overview.

## Structure

```
docs/
├── adrs/                    # Architecture Decision Records (append-only)
│   ├── _template.md
│   └── NNN-title.md
└── specs/                   # Implementation specs
    ├── _template.md
    ├── archive/             # Completed or abandoned specs
    └── {date}-{name}.md    # Active specs

ai-docs/specs/               # Agent-generated specs (from /develop workflow)
```

## Instructions

### Creating an ADR

1. Read `docs/adrs/_template.md` for the format (if it exists)
2. Find the next number by listing existing ADRs: `ls docs/adrs/[0-9]*.md`
3. Create `docs/adrs/{NNN}-{kebab-title}.md` with:
   - Today's date
   - Status: `Draft` (or `Accepted` if decision is final)
   - Filled-in Context, Decision, Options Considered, Consequences
4. Keep it concise — ADRs capture *why*, not *how*

### Creating a Spec

1. Read existing specs for format examples
2. Create `docs/specs/{YYYY-MM-DD}-{kebab-title}.md` or `ai-docs/specs/{issue-slug}.md` with:
   - `status: draft` initially
   - Goal, Architecture, Files, Implementation Steps, Open Questions
3. Fill in enough detail that an implementer can code without guessing

### Archiving a Spec

1. Add a blockquote at the top: `> **Archived:** {what was built, where, key stats}`
2. Update status to `implemented` or `abandoned`
3. Move to `docs/specs/archive/` or `ai-docs/specs/archive/`

### Status Conventions

**ADRs:** `Draft` -> `Accepted` -> `Superseded by ADR-NNN` (never deleted)

**Specs:** `draft` -> `in-progress` -> `implemented` | `abandoned` (archived when terminal)

## Key Rules

- Status lives in frontmatter/header, not folder structure. Only `archive/` is a folder-based signal.
- ADRs are numbered and append-only. Superseded ADRs stay in place with updated status.
- Specs are dated. Multiple active specs are fine.
- Don't over-document. If it's in the code or git history, don't repeat it in docs.
