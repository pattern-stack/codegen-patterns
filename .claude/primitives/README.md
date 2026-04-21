# Primitives

Primitives are configurable context that customize how agents and commands behave for a given project. Think of them as dependency injection for AI workflows — the agents stay generic, the primitives supply the project-specific knowledge.

## How It Works

1. **`sdlc.yml`** at `.claude/sdlc.yml` declares which primitives the project uses
2. **Agents read** `sdlc.yml`, then load the referenced primitive files
3. **Commands resolve** to concrete values (gate commands, label taxonomy, commit format) at execution time

A project adopting this system only needs to:
1. Pick values for each category in `sdlc.yml`
2. Override concrete commands via the `commands:` block

No agent source needs to change.

## Directory Structure

```
primitives/
├── language/             # Programming language conventions + default commands
│   ├── typescript.md
│   ├── python.md
│   └── go.md
├── framework/            # Framework-specific patterns (optional)
│   └── nestjs.md
├── quality/              # Quality gate profiles
│   ├── strict.md
│   └── fast.md
├── commit/               # Commit message styles
│   ├── conventional.md
│   └── freeform.md
├── task-management/      # Issue tracker integration
│   ├── github.md
│   └── linear.md
└── session-logging.md    # Execution journal + audit trail
```

## `sdlc.yml` Schema

```yaml
# Required
language: typescript | python | go | ...     # -> primitives/language/{value}.md
quality_profile: strict | fast               # -> primitives/quality/{value}.md
commit_style: conventional | freeform        # -> primitives/commit/{value}.md
task_management: github | linear             # -> primitives/task-management/{value}.md

# Optional
framework: nestjs | nextjs | fastapi | ...   # -> primitives/framework/{value}.md
session_logging: enabled | disabled          # -> primitives/session-logging.md

# Concrete command overrides (see below)
commands:
  typecheck: ...
  test: ...
  ...
```

## The `commands:` Override Pattern

Gate commands (`typecheck`, `lint`, `test`, `build`, …) vary wildly across projects — even within the same language. A TypeScript project might use `bun run test`, `pnpm test`, or `just test`. The primitives system resolves this cleanly:

**Resolution order** (agents follow this for every gate):
1. Look up the gate in `sdlc.yml`'s `commands:` block — use that command verbatim
2. Otherwise, use the default from the language primitive's command table
3. If neither provides one and the quality profile requires that gate → stop and report

This lets the **language primitive ship sensible defaults** while each **project overrides as needed**. The agent stays agnostic.

### Example

Language primitive (`language/typescript.md`) defines defaults:

| Gate | Default |
|------|---------|
| `typecheck` | `bunx tsc --noEmit` |
| `test` | `bun test` |
| `build` | `bun run build` |

A project using `just` targets overrides in `sdlc.yml`:

```yaml
commands:
  typecheck: bun run typecheck
  test: just test-unit
  test_integration: just test-integration
  build: bun run build
```

The implementer and validator agents read `sdlc.yml.commands.test` → `just test-unit` and execute that. If the project added a new gate (`test_baseline: just test-baseline`) the validator would pick it up without any agent change.

### Standard Gate Names

Use these canonical names when possible so the language / quality primitives can refer to them:

- `format`, `format_check`, `format_fix`
- `lint`
- `typecheck`
- `test`, `test_coverage`, `test_integration`
- `build`
- `security`

Project-specific gates (`test_baseline`, `test_e2e`, `migration_check`, …) are fine — just pick a descriptive snake_case name.

## Adding a New Primitive

### 1. Choose a Category

Use an existing category or create a new one:
- `language/` — new programming language
- `framework/` — new framework
- `quality/` — new quality profile (e.g., `prototype`)
- `commit/` — new commit message format
- `task-management/` — new issue tracker

### 2. Create the File

Follow the shape of existing primitives in that category:
- **Language:** file patterns, default command table, conventions, test naming, strategy notes
- **Framework:** module / component patterns, routing, DI conventions, framework-specific gates
- **Quality:** required gates, optional gates, coverage thresholds, when to use
- **Commit:** format, examples, strategy implications
- **Task management:** concepts, issue structure, label taxonomy, CLI / MCP reference, issue template

### 3. Reference in `sdlc.yml`

```yaml
language: your-new-language
```

Agents will pick it up automatically on the next run.

## Primitive File Guidelines

1. **Be specific** — concrete examples, not vague guidance
2. **Include tooling** — list actual commands agents should run
3. **Show patterns** — file patterns, naming conventions, structure
4. **Keep it focused** — one primitive = one concern
5. **Defer to overrides** — primitives provide defaults; `sdlc.yml` is authoritative
