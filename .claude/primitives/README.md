# Primitives

Primitives are configurable context that customize how commands behave for your project. Think of them as dependency injection for AI workflows.

## How It Works

1. **Commands declare** which primitives they need (in frontmatter)
2. **You configure** which values to use (in `.claude/sdlc.yml`)
3. **Claude reads** the primitive file and follows its guidance

## Directory Structure

```
primitives/
├── language/           # Programming language conventions
│   ├── typescript.md
│   └── python.md
├── quality/            # Quality gate profiles
│   ├── strict.md
│   └── fast.md
├── commit/             # Commit message styles
│   ├── conventional.md
│   └── freeform.md
└── task-management/    # Issue tracker integration
    ├── github.md
    ├── linear.md
    └── jira.md
```

## Creating Custom Primitives

### 1. Choose a Category

Use an existing category or create a new one:
- `language/` - For new programming languages
- `quality/` - For new quality profiles
- `commit/` - For commit message formats
- `task-management/` - For issue trackers
- `framework/` - For framework-specific guidance (create this folder)

### 2. Create the File

```markdown
# {Category}: {Value}

Brief description of when to use this primitive.

## Key Patterns

- Pattern 1
- Pattern 2

## Tooling

Commands and tools relevant to this primitive.

## Conventions

Specific conventions Claude should follow.
```

### 3. Reference in Config

```yaml
# .claude/sdlc.yml
category: your-value
```

## Example: Adding a Framework Primitive

Create `primitives/framework/nextjs.md`:

```markdown
# Framework: Next.js

Use for Next.js applications with App Router.

## File Patterns

- `app/` - App Router pages and layouts
- `components/` - React components
- `lib/` - Utility functions
- `public/` - Static assets

## Tooling

| Task | Command |
|------|---------|
| Dev | `npm run dev` |
| Build | `npm run build` |
| Lint | `npm run lint` |
| Test | `npm test` |

## Conventions

- Use Server Components by default
- Add 'use client' only when needed
- Colocate components with their routes
- Use Next.js Image component for images
```

Then in your project:

```yaml
# .claude/sdlc.yml
language: typescript
framework: nextjs
```

## Primitive File Guidelines

1. **Be specific** - Give concrete examples, not vague guidance
2. **Include tooling** - List actual commands Claude should run
3. **Show patterns** - File patterns, naming conventions, structure
4. **Keep it focused** - One primitive = one concern

## How Commands Use Primitives

Commands declare primitives in frontmatter:

```yaml
---
primitives:
  required:
    - language        # Must be configured
  optional:
    - quality_profile # Nice to have
---
```

When the command runs, Claude:
1. Resolves the primitive value from config (e.g., `language: typescript`)
2. Reads the primitive file (e.g., `primitives/language/typescript.md`)
3. Follows the guidance in that file during execution

This happens automatically - you just need to configure `.claude/sdlc.yml`.
