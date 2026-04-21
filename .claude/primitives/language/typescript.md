# Language: TypeScript

Conventions, tooling, and default commands for TypeScript projects.

## File Patterns

| Kind | Pattern |
|------|---------|
| Source | `**/*.ts`, `**/*.tsx` |
| Tests | `**/*.test.ts`, `**/*.spec.ts`, `**/*.test.tsx` |
| Config | `tsconfig.json`, `package.json` |
| Lock | `bun.lock`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` |

## Default Commands

These are the defaults agents will run if `sdlc.yml` does not provide project-specific `commands:` overrides. The runtime (bun / pnpm / npm / yarn) and the scripts defined in `package.json` vary by project — always prefer explicit overrides in `sdlc.yml` over these defaults.

| Gate | Default |
|------|---------|
| `typecheck` | `bunx tsc --noEmit` |
| `lint` | `bun run lint` |
| `format_check` | `bun run format:check` |
| `format_fix` | `bun run format` |
| `test` | `bun test` |
| `test_coverage` | `bun test --coverage` |
| `test_integration` | `bun run test:integration` |
| `build` | `bun run build` |

If a project uses `npm`, `pnpm`, or `yarn`, substitute accordingly and set `commands:` in `sdlc.yml`.

## Conventions

- Strict mode on (`"strict": true` in `tsconfig.json`)
- Prefer `interface` for object shapes, `type` for unions / utility types
- Avoid `any` — use `unknown` with type guards when the shape is unknown
- Barrel exports (`index.ts`) at package / module boundaries only — not inside modules
- Co-locate tests next to source (`foo.ts` + `foo.test.ts`) unless the project convention dictates a separate tree

## Test Naming

```ts
describe('<unit>', () => {
  it('<behavioral expectation>', () => { /* ... */ });
});
```

Test names describe observable behavior, not implementation (`'returns 404 when user is missing'`, not `'calls repository.findOne'`).

## Strategy Considerations

When planning TypeScript work:
- Identify the module system (ESM vs CommonJS) — it affects imports and tooling
- Identify the framework — see `framework/*` primitive if configured (NestJS, Next.js, etc.)
- Identify the runtime (Node vs Bun vs Deno) — affects which APIs and commands are available
- Locate existing shared types (often under `types/`, `shared/`, or a workspace package) before inventing new ones
