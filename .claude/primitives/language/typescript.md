# TypeScript Language Primitive

Instructions for TypeScript-specific workflows.

## File Patterns

- Source: `**/*.ts`, `**/*.tsx`
- Tests: `**/*.test.ts`, `**/*.spec.ts`
- Config: `tsconfig.json`, `package.json`

## Toolchain

| Tool | Command | Purpose |
|------|---------|---------|
| Format | `prettier` | Code formatting |
| Lint | `eslint` | Linting |
| Typecheck | `tsc --noEmit` | Type checking |
| Test | `jest` or `vitest` | Test runner |

## Conventions

- Prefer `interface` over `type` for object shapes
- Use strict mode (`strict: true` in tsconfig)
- Avoid `any` - use `unknown` with type guards
- Use barrel exports (`index.ts`) for public APIs

## Strategy Considerations

When planning TypeScript implementations:
- Check for existing patterns (React components, API routes)
- Identify module system (ESM vs CommonJS)
- Note framework conventions (Next.js, Express, etc.)
- Review existing type definitions and shared types
