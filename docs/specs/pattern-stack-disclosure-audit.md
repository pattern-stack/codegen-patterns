# Pattern-Stack Progressive-Disclosure Audit

Investigation of how `pattern-stack/backend-patterns` structures agent-facing docs so each agent loads only what its current task needs. Source: `/Users/dug/Projects/dev/pattern-stack/backend-patterns`.

## Directory Map

Pattern-stack ships a **Claude Code plugin** living in the repo itself:

```
backend-patterns/
├── .claude-plugin/marketplace.json         # Marketplace manifest
├── plugins/pattern-stack/                  # The plugin root
│   ├── .claude-plugin/
│   │   ├── plugin.json                     # Plugin manifest (name, version)
│   │   └── marketplace.json
│   ├── README.md                           # Human-facing overview
│   ├── agents/                             # Agent definitions (no YAML frontmatter)
│   │   ├── architect.md
│   │   ├── builder.md
│   │   └── reviewer.md
│   └── skills/pattern-stack/               # The knowledge base (the Skill)
│       ├── SKILL.md                        # L0 — always loaded
│       ├── patterns-and-fields.md          # L1 — on-demand
│       ├── building-features.md            # L1
│       ├── building-molecules.md           # L1
│       ├── building-organisms.md           # L1
│       ├── infrastructure-subsystems.md    # L1  (jobs, cache, storage, events)
│       ├── testing-patterns.md             # L1
│       └── project-bootstrap.md            # L1
└── .claude/                                # Project-local, NOT shipped in plugin
    ├── agents/*.md                         # Uses YAML frontmatter (name, description)
    ├── skills/pattern-stack/               # (empty shell; real content under plugins/)
    ├── commands/, patterns/, ai-docs/, docs/, hooks/, status_lines/, specs/
    └── settings.json
```

## The Progressive-Disclosure Pattern (reusable shape)

Two-level knowledge hierarchy, explicitly called L0 / L1:

- **L0 = `SKILL.md`** — one file per skill. Auto-loaded when the skill activates. Contains: activation blurb, an **L1 routing table** (task → filename), architecture overview, decision guides, anti-patterns, key imports. Target size ~150 lines.
- **L1 = topic docs** — sibling markdown files in the same folder as `SKILL.md`. Each covers exactly one domain in depth (200–335 lines). Loaded only when an agent follows the L0 routing table to them.

Naming conventions:
- `SKILL.md` is the reserved L0 filename.
- L1 files use `verb-noun.md` or `noun-noun.md` (e.g. `building-features.md`, `infrastructure-subsystems.md`).
- No `*.detail.md`, `*.summary.md`, or `*.overview.md` — the boundary is encoded in the folder/filename scheme, not suffixes.

Frontmatter conventions:
- **Plugin-shipped** agents (`plugins/pattern-stack/agents/*.md`) and skill files use **no YAML frontmatter** — the `.claude-plugin/plugin.json` manifest and the filename itself handle registration.
- **Project-local** `.claude/agents/*.md` files DO use YAML frontmatter (`--- name: … description: …`) so the harness can list them via `/agents`.
- No explicit SKIP/TRIGGER rules in-file. Routing is prescriptive: each agent's system prompt tells it to read `SKILL.md` always, then read specific L1 docs keyed by the current task. Lazy-loading is driven by the agent *deciding* which L1 to read — there is no runtime gating.

Cross-references:
- `SKILL.md` has a "Task → Reference" table pointing at L1 filenames (relative paths).
- Individual L1 files cross-reference each other inline: e.g. `building-features.md` says "see `patterns-and-fields.md` for full reference" when touching model choice.
- Agent prompts reference the skill via `${CLAUDE_PLUGIN_ROOT}/skills/pattern-stack/SKILL.md` — the harness-supplied env var.

## Two Concrete Examples

**Example 1 — Jobs (inside `infrastructure-subsystems.md`).** All four subsystems (jobs, cache, storage, events, integrations, broadcast) share a single L1 file because they follow the same Protocol → Backend → Factory shape. Each gets its own `##` section with Protocol signature, backend list, usage snippet, and handler pattern. L0 only has an 8-line summary table — the 90-line jobs deep-dive sits in L1 and isn't loaded unless an agent is working with the Jobs subsystem. File: `plugins/pattern-stack/skills/pattern-stack/infrastructure-subsystems.md`.

**Example 2 — Feature building.** `SKILL.md` gives you the layer rules and a "where does this code go?" table. When an agent is actually implementing a feature, it reads `building-features.md` which walks through model → schemas/input.py → schemas/output.py → service.py, with full code for each step. File: `plugins/pattern-stack/skills/pattern-stack/building-features.md`.

## Plugin Registration Mechanics

1. `plugins/pattern-stack/.claude-plugin/plugin.json` — required. Declares `name`, `version`, `description`, `author`, `repository`. No explicit skill/agent arrays — the harness auto-discovers anything under `agents/` and `skills/`.
2. `plugins/pattern-stack/.claude-plugin/marketplace.json` — lists installable plugins with `source: "./"`.
3. Top-level `.claude-plugin/marketplace.json` at repo root points at `./plugins/pattern-stack`.
4. Install via `/plugin install pattern-stack@pattern-stack-plugins`. Loaded skills expose themselves as `pattern-stack:architect`, `pattern-stack:builder`, `pattern-stack:reviewer` — matching the agent filenames under `plugins/pattern-stack/agents/`.
5. Agents refer to their own skill docs via `${CLAUDE_PLUGIN_ROOT}/skills/pattern-stack/…`.

## Recommendation for codegen-patterns

Adopt the same L0/L1 shape, but start small and inside `.claude/skills/` first (no need to go full plugin until we want to distribute).

**Canonical layout** (skills live one folder per domain; each domain is self-contained):

```
codegen-patterns/.claude/skills/
├── codegen/                             # L0 router for the whole system
│   └── SKILL.md                         # Task→domain table; always loaded
├── jobs/
│   ├── SKILL.md                         # L0 for the jobs domain
│   ├── pg-boss-backend.md               # L1 — production backend detail
│   ├── memory-backend.md                # L1 — test backend detail
│   ├── handlers-and-workers.md          # L1 — handler patterns, concurrency
│   └── testing-jobs.md                  # L1 — fixtures, fake clocks
└── events/
    ├── SKILL.md                         # L0 for the events domain
    ├── outbox-backend.md                # L1 — Drizzle outbox backend
    ├── memory-backend.md                # L1
    ├── subscribers-and-bus.md           # L1 — IEventBus usage, wiring
    └── testing-events.md                # L1
```

Rules to adopt:
- Each domain folder contains exactly one `SKILL.md` (L0). Keep it under ~150 lines. Must include: activation blurb, **L1 routing table**, architecture snapshot for that domain, decision guides, anti-patterns.
- L1 files are siblings with descriptive kebab-case names. Each L1 covers one thing deeply (200–300 lines is fine).
- No YAML frontmatter on skill files; rely on folder-as-skill discovery.
- Agent prompts (if/when we add them) say "Always read `SKILL.md`; read L1 `X.md` when task involves X."
- Cross-domain pointers inline: the jobs `SKILL.md` can link to `../events/SKILL.md` when explaining job-completion events.
- Top-level `codegen/SKILL.md` (or fold into the existing top-level `CLAUDE.md`) owns the cross-domain routing table so an agent with no context can find the right L0.

**First increment (jobs + events):** create the two folders above with just the L0 `SKILL.md` files plus one or two L1s each — move the detail currently sitting in `docs/specs/events-codegen-plan.md`, `docs/specs/dealbrain-bullmq-audit.md`, `runtime/subsystems/jobs/`, and `runtime/subsystems/events/` READMEs into the L1 files. Keep the top-level `CLAUDE.md` as the always-loaded surface; have it point at `.claude/skills/jobs/SKILL.md` and `.claude/skills/events/SKILL.md` via a one-line table. This gives us the split-by-domain lazy loading without committing to plugin packaging yet — we can promote to `plugins/codegen-patterns/` later using the exact manifest shape described above.
