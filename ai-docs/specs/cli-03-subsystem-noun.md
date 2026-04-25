# SPEC-CLI-03: Subsystem Noun — Summary, Install, List, Remove

**Status:** Draft
**Date:** 2026-04-13
**Depends on:** SPEC-CLI-01 (NounModule abstraction), SPEC-CLI-02 (shared hygen helper), ADR-015, ADR-016, ADR-008

---

## Purpose

Implement the `subsystem` noun — the second of two P0 surfaces (alongside `entity`). This spec covers copying `runtime/subsystems/<name>/` into a user's project, wiring it into their app module, and exposing the state via the summary pane.

Subsystems: `events`, `jobs`, `cache`, `storage` (ADR-008).

- `codegen subsystem` — summary: installed vs available matrix + hints
- `codegen subsystem install <name>` — install a subsystem into the user's project
- `codegen subsystem list` — tabular installed + available
- `codegen subsystem remove <name>` — uninstall (deferred to follow-up spec; stubbed with "not implemented" message)

---

## Files to Create or Modify

| File | Action | Notes |
|------|--------|-------|
| `src/cli/commands/subsystem.ts` | create | NounModule + Command classes |
| `src/cli/shared/runtime-copier.ts` | create | Copy `runtime/<subdir>` into user's project with dependency resolution |
| `src/cli/shared/subsystem-detect.ts` | create | Detect which subsystems are already installed |
| `src/cli/index.ts` | modify | Register subsystem noun |
| `src/__tests__/cli/subsystem.test.ts` | create | Unit tests |
| `justfile` | modify | Update `gen-subsystem` recipe |

---

## Summary Pane

**`summary(ctx)`** returns:

```
┌─ subsystems ─────────────────────────────────────────────┐
  Installed:
    ✓ events     drizzle backend   src/shared/subsystems
    ✓ cache      drizzle backend   src/shared/subsystems

  Available:
    ◌ jobs       not installed
    ◌ storage    not installed

  2 of 4 subsystems installed
└──────────────────────────────────────────────────────────┘

  Next:
    codegen subsystem install jobs     Install the jobs subsystem
    codegen subsystem install storage  Install the storage subsystem
```

If no subsystems are installed:

```
  Available:
    ◌ events     Domain event bus (transactional outbox)
    ◌ jobs       Background job queue
    ◌ cache      Key-value cache with TTL
    ◌ storage    File/object storage

  No subsystems installed yet.
```

**`hints(ctx)`** — state-aware:

| State | Hints |
|-------|-------|
| Not initialized | `codegen init` |
| None installed | `codegen subsystem install events`, `codegen subsystem install cache` |
| Some installed | `codegen subsystem install <missing-name>` for each missing |
| All installed | `codegen subsystem list` |

---

## `codegen subsystem install <name>`

**Class:** `SubsystemInstallCommand`
**Path:** `[['subsystem', 'install']]`

**Options:**
- `name` — positional, required. One of `events | jobs | cache | storage`.
- `--backend <backend>` — `drizzle | memory`. Default depends on subsystem (drizzle for events/jobs/cache, local filesystem for storage).
- `--target <path>` — override install path. Otherwise cascades: config → prompt → sensible default (`src/shared/subsystems/`).
- `--force` — overwrite existing files without confirmation.
- `--yes` / `-y` — skip all interactive prompts; use defaults.
- `--dry-run` — plan only.

### Target Path Resolution

Cascade (decision #1 from the user):

1. If `--target` flag given, use it.
2. If `ctx.config.paths.subsystems` is set in `codegen.config.yaml`, use that.
3. Otherwise prompt via `@clack/prompts`: "Where should subsystem files live?" with default `src/shared/subsystems/`.
4. If `--yes`, skip the prompt and use the default.

The resolved path is stored back to `codegen.config.yaml` (under `paths.subsystems`) if it was prompted — so subsequent installs reuse the same location without asking.

### Install Flow

1. Load context.
2. Resolve name (validate against known subsystems). If unknown, fail with list.
3. Check if already installed via `detectInstalledSubsystems(ctx)`. If yes and not `--force`, report "already installed" and exit 0.
4. Resolve target path (cascade above).
5. Resolve backend (default or `--backend`). Validate against subsystem's supported backends.
6. Check git safety on target path (reuse `checkGitSafety` from SPEC-CLI-02). If dirty, warn + require `--force` or confirm.
7. Copy `runtime/subsystems/<name>/*` into `<target>/<name>/`:
   - Use `runtimeCopier.copy(sourceDir, targetDir, { resolveDeps: true })`.
   - Resolve transitive deps: `runtime/subsystems/events/` depends on `runtime/constants/tokens.ts` and `runtime/types/drizzle.ts`. Copier ensures those are present (copies to `<target>/../constants/` and `<target>/../types/` if missing).
8. Filter copied files by backend choice:
   - If `--backend memory`, omit `*.drizzle-backend.ts` and `*.schema.ts`.
   - If `--backend drizzle`, omit `*.memory-backend.ts`.
9. Invoke Hygen injects for `app.module.ts` to register the subsystem module (reuses existing `templates/subsystem/<name>/_inject-app-module.ejs.t` — if it doesn't exist, generate from template).
10. If backend is drizzle, inject the schema export into the user's `schema.ts` barrel.
11. Print result.

### Output (success)

```
✓ resolved target = src/shared/subsystems/ (from config)
✓ checked git safety — clean
✓ copied runtime/subsystems/events/ → src/shared/subsystems/events/ (8 files)
✓ copied runtime/constants/tokens.ts → src/shared/constants/tokens.ts (new)
✓ copied runtime/types/drizzle.ts → src/shared/types/drizzle.ts (new)
✓ updated src/app.module.ts — registered EventsModule
✓ updated src/schema.ts — exported domainEvents

events subsystem installed with drizzle backend.
```

### JSON output

```json
{
  "command": "subsystem install",
  "subsystem": "events",
  "backend": "drizzle",
  "target": "src/shared/subsystems/events",
  "files": {
    "written": [...],
    "updated": [...],
    "unchanged": []
  }
}
```

### Exit codes

- 0 — success, or already installed and no `--force`
- 1 — copy or inject failed
- 2 — unknown subsystem name or invalid `--backend` for subsystem

---

## `codegen subsystem list`

**Class:** `SubsystemListCommand`
**Path:** `[['subsystem', 'list']]`

Pure data output, no pane.

```
NAME      STATUS       BACKEND    PATH
events    installed    drizzle    src/shared/subsystems/events
cache     installed    drizzle    src/shared/subsystems/cache
jobs      available    —          —
storage   available    —          —
```

**Options:**
- `--format <plain|json>` — default plain.

---

## `codegen subsystem remove <name>`

**Class:** `SubsystemRemoveCommand`
**Path:** `[['subsystem', 'remove']]`

For MVP, prints:

```
✗ subsystem remove is not yet implemented.
  Manually delete the subsystem directory and remove the module
  registration from your app.module.ts.
```

Exits 1. Full implementation tracked as a follow-up spec — it needs to handle inject reversal, which is non-trivial with Hygen.

---

## Shared Helpers

### `src/cli/shared/runtime-copier.ts`

```typescript
export interface RuntimeCopyOptions {
  sourceDir: string;           // e.g. path to "runtime/subsystems/events"
  targetDir: string;           // e.g. path to user's "src/shared/subsystems/events"
  filter?: (file: string) => boolean;   // skip e.g. *.drizzle-backend.ts if memory-only
  resolveDeps?: boolean;       // copy referenced files from runtime/types, runtime/constants
  dryRun?: boolean;
}

export async function copyRuntime(opts: RuntimeCopyOptions): Promise<RuntimeCopyResult>;

export interface RuntimeCopyResult {
  written: string[];
  updated: string[];
  unchanged: string[];
  dependenciesCopied: string[];
}
```

The copier:
- Reads all `.ts` files in `sourceDir`, applies `filter`, rewrites import paths as needed (e.g. `../../constants/tokens` → `../../constants/tokens` if layout matches; re-maps if target layout differs).
- If `resolveDeps`, parses imports and copies any referenced `runtime/*` file it hasn't already copied.
- Skips files that already exist with identical content (marks as `unchanged`).

### `src/cli/shared/subsystem-detect.ts`

```typescript
export async function detectInstalledSubsystems(ctx: Context): Promise<InstalledSubsystem[]>;

export interface InstalledSubsystem {
  name: 'events' | 'jobs' | 'cache' | 'storage';
  path: string;                 // absolute path where it's installed
  backend: 'drizzle' | 'memory' | 'local' | 'unknown';
}
```

Detection:
- Scans the configured `paths.subsystems` directory (or common defaults: `src/shared/subsystems`, `src/subsystems`) for subsystem directories.
- A subsystem is "installed" if `<dir>/<name>/<name>.protocol.ts` exists.
- Backend is inferred from which backend files are present.

---

## Testing

`src/__tests__/cli/subsystem.test.ts`:

- `install events --dry-run` reports planned writes without touching disk
- `install events --backend memory` omits `*.drizzle-backend.ts`
- `install events` twice is idempotent (second run reports "already installed")
- `install events --force` overwrites
- `list` reflects detection correctly in a fixture project with events installed
- `detectInstalledSubsystems()` unit tests against fixture project layouts

Uses a temp-directory fixture project (`test/fixtures/scaffold-minimal/`) as the install target.

---

## Migration Notes

- Old `bun src/cli.ts subsystem <name>` continues to work during the transition.
- `justfile` `gen-subsystem` recipe is updated to `bun src/cli/index.ts subsystem install {{name}}`.
- Once all subsystem flows are in the new CLI, the old `subsystem` handler in `src/cli.ts` is deleted.
