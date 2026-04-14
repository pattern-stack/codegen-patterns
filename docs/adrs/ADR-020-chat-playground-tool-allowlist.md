# ADR-020 — Chat Playground Tool Allowlist

**Status:** Draft
**Date:** 2026-04-14
**Owner:** Doug
**Related:** ADR-015 (CLI Command Architecture), ADR-016 (CLI UI System), ADR-018 (Interactive Surface on Bubble Tea), #31

## Context

Issue pattern-stack/codegen-patterns#31 proposes a Bubble Tea TUI with a **Playground → Chat** screen that embeds the `pattern-stack/chat-patterns` package. That package already ships a Claude Code adapter (`_examples/claude-code/main.go`), so the Chat pane operates the user's project through a scoped toolset exposed by the adapter.

The playground experience should feel fluid — the agent should be able to draft YAML, preview diffs, validate entities, and run a dry-run generate without friction — while staying safe. The commands the agent has access to span a wide safety spectrum:

| Operation | Risk | Existing gate |
|---|---|---|
| `Read`, `Glob`, `Grep` on project files | none | n/a |
| Write `entities/*.yaml` | low (validated by Zod before save) | Zod schema + `codegen entity validate` |
| `codegen entity new <file>` | mutates generated source | `checkGitSafety()`, `--force`, `--dry-run` |
| `codegen entity new --all` | mass source rewrite | `checkGitSafety()`, `--force`, `--dry-run` |
| `codegen subsystem install <name>` | copies files under `shared/subsystems/`, updates wiring | `checkGitSafety()`, `--force`, `--dry-run` |
| `codegen project init --yes` | scaffolds config, shims, barrels, app.module | `--force`, `--dry-run` |
| `codegen dev up` | starts Docker (Postgres + Redis), writes `.dev-app.pid`, spawns NestJS | none — assumes user consented |
| `codegen dev down` | kills NestJS, stops Docker | none |
| Arbitrary shell (`rm`, `git push`, `curl`) | unbounded | none |

The existing CLI already encodes the right safety primitives for its own use: `checkGitSafety()` in `src/cli/shared/git-safety.ts` warns before overwriting files with uncommitted changes, and every mutating command supports `--dry-run` to preview without writing. Clipanion options (`--force`, `--yes`) force through confirmations. These gates are authoritative for the CLI and must remain authoritative when the agent invokes them.

The question this ADR answers: **which tools is the embedded chat agent allowed to run, which require user approval in the TUI, and how does that approval work?**

A single allow/deny toggle is too coarse — drafting YAML should not prompt every time. A per-call prompt for everything kills the UX. We need a tiered model whose categories align with the existing CLI safety gates rather than reinventing them.

## Decision

A four-tier allowlist, enforced in the Claude Code adapter (where tools are declared to the agent) **before** the tool call reaches the agent's environment. Enforcement point is the adapter, not the agent, because the adapter is what the embedding TUI controls — the agent receives only the set of tools the adapter exposes.

### Tier 1 — auto-allowed (read-only + YAML drafting)

No prompt. The agent runs these freely.

- `Read`, `Glob`, `Grep` scoped to paths under the project root (no escapes with `..` or absolute paths outside `cwd`).
- `codegen` read-only subcommands (always with `--json`):
  - `codegen project config`
  - `codegen project scan --dry-run`
  - `codegen project inspect --kind analyze|stats|doc|manifest|suggestions` (read mode — no `--accept`/`--skip`/`--force`)
  - `codegen entity list`
  - `codegen entity validate`
  - `codegen subsystem list`
  - `codegen dev status`
  - `codegen dev logs`
- `Write` / `Edit` restricted to:
  - `entities/**/*.yaml` (validated against `EntityDefinitionSchema` before save)
  - `codegen.config.yaml` (validated against the relevant Zod schemas before save)

### Tier 2 — prompt the user, approvable with "remember for session"

The TUI shows an inline confirmation row at the bottom of the chat pane. Default affordances:

```
↵ approve · x deny · a always (this session) · d always (always dry-run)
```

Approval granted with `a` persists **for the current TUI session only** — it does not survive a restart or a new session under `.codegen/sessions/`.

- `codegen entity new <file>`
- `codegen entity new --all`
- `codegen subsystem install <name> [--backend <b>]`
- `codegen project init --yes`
- `codegen project scan --write`
- `codegen project inspect --kind suggestions --accept <id>` or `--skip <id>` (single-suggestion mutations)
- `Bash` restricted to `codegen <noun> <verb>` invocations where the resulting command itself is in Tier 1 or Tier 2

### Tier 3 — always explicit per-call (no session memory)

The TUI shows a blocking modal with the full command string and a short explanation. Approval never persists — each call prompts fresh.

- `codegen dev up`
- `codegen dev down`
- `codegen dev restart`
- Any `codegen` command with `--force`
- `codegen project inspect --kind suggestions --accept-all` or `--skip-all` (bulk mutations)
- `Write` / `Edit` to any path outside `entities/**/*.yaml` and `codegen.config.yaml`
- `Bash` resolving to anything outside `codegen <noun> <verb>`

### Tier X — denied outright (not exposed to the agent)

The adapter does not declare these tools. The agent cannot call them; the TUI cannot elevate.

- Destructive shell: `rm`, `mv`, `git push`, `git reset --hard`, `git checkout --`, `git clean -f`, `docker` (raw), `kill -9`
- Network calls that are not mediated by `codegen` itself (`curl`, `wget`, arbitrary `fetch`)
- Writes to `runtime/` or `templates/` (codegen-owned source; these are ours to edit, not the agent's)
- Writes anywhere outside the project root

## Approval UX

### Tier 2 — inline row

The chat pane's bottom-status area flips into an approval row when a Tier 2 tool call is pending. The row shows:

```
codegen entity new entities/invite.yaml
 ↵ approve · x deny · a always (session) · d always (dry-run)
```

- `↵` runs the real command.
- `x` rejects — the agent receives a denial and can adapt.
- `a` approves this exact command shape for the rest of the session; subsequent calls of the same shape skip the prompt.
- `d` approves but substitutes `--dry-run` every time — the agent can iterate freely without ever mutating files.

"Command shape" means `codegen <noun> <verb>` plus any flags the policy considers shape-defining (`--all`, `--backend <b>`, etc.) but not per-call arguments like the YAML path. The policy file (see Implementation Notes) declares shape rules per command.

### Tier 3 — blocking modal

Tier 3 renders a modal dialog in the TUI, full-width, with:

```
┌─ Approval required ──────────────────────────────────┐
│ codegen dev up                                       │
│                                                      │
│ This will start Docker services (Postgres + Redis),  │
│ run database migrations, and spawn the NestJS app    │
│ (writes .dev-app.pid).                               │
│                                                      │
│ [ Approve (↵) ]   [ Deny (x) ]                       │
└──────────────────────────────────────────────────────┘
```

No "remember" affordance. Every call is independent.

### Denial behavior

On deny, the agent's tool-call response is a structured error — `{ "error": "user_denied", "tier": 2|3, "command": "..." }` — not a crash. The agent is expected to adapt (ask the user, try a less invasive approach, or stop).

## Safety integration

Tier 2 commands layer on top of `--dry-run`, not as a replacement:

1. When the agent invokes a Tier 2 command, the adapter first runs it with `--dry-run --json` and returns the structured plan to the agent as a preview.
2. The TUI renders the plan in the workspace pane (file list, diff, or summary — the shape is already defined by each command's `--json` output).
3. Only after the plan is previewed does the approval row render. Approval runs the real command without `--dry-run` (unless the user chose `d always (dry-run)`).

`checkGitSafety()` stays authoritative for `entity new` and `subsystem install` invocations the agent makes — if the working tree is dirty, those commands still fail without `--force`, regardless of allowlist tier. The agent must ask the user to confirm a `--force` invocation; `--force` always falls to Tier 3.

## Consequences

### Positive

- **Fluid where it matters.** Drafting YAML, browsing the graph, validating, and previewing plans are prompt-free. The agent can iterate quickly.
- **Safe where it matters.** Every source mutation, every Docker state change, every `--force` passes through a human gate. The denial path is structured, not catastrophic.
- **Leverages existing CLI gates.** `--dry-run`, `checkGitSafety()`, `--force`, and `--json` are already the CLI's safety vocabulary. The allowlist wraps those; it does not replace them.
- **Enforceable.** The Claude Code adapter is the chokepoint — tools the adapter does not declare cannot be reached. Tier X is not a rule; it's a missing capability.
- **Session-scoped memory.** "Always for session" keeps the common case ergonomic without building a persistent permission store the user has to audit.

### Negative

- **Prompt fatigue is a real risk if miscategorized.** If too many agent actions land in Tier 3, the TUI becomes modal-soup. The initial categorization in this ADR should be revisited after the first real playground sessions.
- **Session memory is lost on restart.** A user who hits `a always` and restarts the TUI will be prompted again for the same shape. This is the right tradeoff (explicit trust renewal) but users may find it repetitive in long-running flows.
- **"Command shape" is a policy concept that has to be maintained.** The allowlist is a file (see Implementation Notes); adding a new CLI verb means adding a shape entry. Forgetting falls through to Tier 3 by default — safe but not necessarily what the author intended.
- **The CLI's `--force` and `--yes` flags become chat-adversarial.** The agent can propose them but cannot land them without Tier 3 approval. This is deliberate — the force flag exists to bypass safety, and the chat playground should not let the agent self-bypass.

### Neutral

- **This is only possible because the chat transport is a typed tool-call API.** If the agent had a raw shell, the allowlist would be defense-in-depth, not enforcement. The chat-patterns adapter gives us a real chokepoint.
- **Tier assignments can evolve.** The tiers are policy, not architecture. Promoting `codegen subsystem install` from Tier 2 to Tier 1 after dogfooding is a policy edit, not a rewrite.
- **The approval UX uses chat-patterns' existing primitives.** The inline row and the modal are both standard Bubble Tea patterns the chat-patterns package already provides via its atoms/molecules — no new component work is implied by this ADR.

## Alternatives Considered

### 1. Single allow/deny toggle per session

One prompt at playground start: "allow the agent to run `codegen` commands?" Rejected — too coarse. The user cannot distinguish "yes to drafting YAML" from "yes to `codegen dev up`." Real approval is command-specific.

### 2. Per-entity or per-file permissions

Grant access to `entities/invite.yaml` specifically. Rejected — too granular. The surface is the commands, not the files; a per-file model would require re-approval every time the agent discovers a new file, which the agent does constantly.

### 3. Auto-approve everything with an audit log

Let the agent run anything and surface an append-only log. Rejected — safety depends on the user being in the loop before the mutation, not after. An audit log is useful for post-hoc review and should exist anyway (the `journal.jsonl` under `.codegen/sessions/` from #31), but it is not a substitute for pre-approval on Tier 2/3.

### 4. Require approval for every call, no exceptions

No session memory, no Tier 1 auto-allow. Rejected — the playground becomes unusable. The agent makes dozens of `Read`/`Grep` calls per turn when exploring the project; prompting each one is dead UX.

### 5. Mirror the allowlist policy from an existing agent framework (e.g. Claude Code's own)

Copy whatever permission model Claude Code uses outside the TUI. Rejected as a goal, informative as a reference: Claude Code's permission model is tuned for a different surface (filesystem operations in a working repo). The TUI is a codegen playground with specific safety seams — `--dry-run`, `checkGitSafety()`, `--force` — that our allowlist should snap to. Cross-pollinate patterns (tier names, denial semantics), but the categories belong to us.

## Implementation Notes

### Policy location

The allowlist lives in a TypeScript file that both the TUI's chat-adapter configuration and any test harness can import:

```
src/chat/tool-policy.ts
```

Shape:

```ts
export type Tier = 1 | 2 | 3;

export interface ToolRule {
  match: {
    tool: 'codegen' | 'Read' | 'Write' | 'Edit' | 'Glob' | 'Grep' | 'Bash';
    noun?: string;       // for tool: 'codegen'
    verb?: string;       // for tool: 'codegen'
    flags?: string[];    // shape-defining flags (e.g. ['--all'])
    pathGlob?: string;   // for Write/Edit/Read/Glob/Grep
    bashPrefix?: string; // for Bash: required command prefix (e.g. 'codegen ')
  };
  tier: Tier;
  note?: string;         // used by the Tier 3 modal's explanation
}

export const TOOL_POLICY: ToolRule[] = [
  // Tier 1 — read-only + YAML drafting
  { match: { tool: 'Read' }, tier: 1 },
  { match: { tool: 'Glob' }, tier: 1 },
  { match: { tool: 'Grep' }, tier: 1 },
  { match: { tool: 'codegen', noun: 'entity', verb: 'list' }, tier: 1 },
  { match: { tool: 'codegen', noun: 'entity', verb: 'validate' }, tier: 1 },
  { match: { tool: 'codegen', noun: 'subsystem', verb: 'list' }, tier: 1 },
  { match: { tool: 'codegen', noun: 'project', verb: 'config' }, tier: 1 },
  { match: { tool: 'codegen', noun: 'project', verb: 'scan', flags: ['--dry-run'] }, tier: 1 },
  { match: { tool: 'codegen', noun: 'project', verb: 'inspect' }, tier: 1,
    note: 'read-only inspection; --accept/--skip/--accept-all/--skip-all fall to higher tiers' },
  { match: { tool: 'codegen', noun: 'dev', verb: 'status' }, tier: 1 },
  { match: { tool: 'codegen', noun: 'dev', verb: 'logs' }, tier: 1 },
  { match: { tool: 'Write', pathGlob: 'entities/**/*.yaml' }, tier: 1 },
  { match: { tool: 'Edit',  pathGlob: 'entities/**/*.yaml' }, tier: 1 },
  { match: { tool: 'Write', pathGlob: 'codegen.config.yaml' }, tier: 1 },
  { match: { tool: 'Edit',  pathGlob: 'codegen.config.yaml' }, tier: 1 },

  // Tier 2 — prompt, session-approvable
  { match: { tool: 'codegen', noun: 'entity', verb: 'new' }, tier: 2 },
  { match: { tool: 'codegen', noun: 'subsystem', verb: 'install' }, tier: 2 },
  { match: { tool: 'codegen', noun: 'project', verb: 'init', flags: ['--yes'] }, tier: 2 },
  { match: { tool: 'codegen', noun: 'project', verb: 'scan', flags: ['--write'] }, tier: 2 },
  { match: { tool: 'Bash', bashPrefix: 'codegen ' }, tier: 2 },

  // Tier 3 — always explicit, no memory
  { match: { tool: 'codegen', noun: 'dev', verb: 'up' },     tier: 3,
    note: 'Starts Docker (Postgres + Redis), pushes schema, spawns NestJS.' },
  { match: { tool: 'codegen', noun: 'dev', verb: 'down' },   tier: 3,
    note: 'Stops Docker services and kills the NestJS process.' },
  { match: { tool: 'codegen', noun: 'dev', verb: 'restart' }, tier: 3,
    note: 'Restarts the NestJS process; kills and respawns.' },
  { match: { tool: 'codegen', flags: ['--force'] }, tier: 3,
    note: '--force bypasses git-safety and overwrite protections.' },
];
```

Anything that does not match any rule falls through to **deny** (Tier X). That is deliberate: new, uncategorized capabilities are never auto-granted.

### Enforcement path

```
agent tool call
     │
     ▼
chat-patterns adapter (src/chat/claude-code-adapter.ts — project-local)
     │
     ├─ resolve rule via TOOL_POLICY
     ├─ Tier X → return { error: "tool_not_available" } to agent
     ├─ Tier 1 → invoke immediately (codegen with --json / filesystem op)
     ├─ Tier 2 → if session-approved for this shape: invoke
     │         else: run --dry-run --json → render preview →
     │               emit approval-row request to TUI → await decision
     ├─ Tier 3 → always: render modal-request → await decision
     │
     ▼
invocation returns structured result to agent
journal.jsonl appends { ts, tool, tier, decision, command, result }
```

The adapter never calls `codegen` without `--json`. The TUI's workspace pane renders the structured result the same way it would render a hand-invoked command's output.

### Session-scoped approval store

An in-memory `Set<string>` keyed by command shape, owned by the TUI's session controller. Cleared on TUI exit. Not persisted. The `.codegen/sessions/<ts>/journal.jsonl` captures the decision trail for after-the-fact review; it does not feed approvals forward.

### --dry-run dependence

Every Tier 2 command must support `--dry-run --json` cleanly (structured plan, no side effects). The existing CLI largely does — `entity new --dry-run --json` already emits the planned entities and barrels; `subsystem install --dry-run --json` emits the planned file list. If a future Tier 2 command lacks `--dry-run`, it cannot be Tier 2 — it falls to Tier 3 until the dry-run is implemented.

### Relationship to `--interactive`

ADR-018 dropped the `--interactive` flag. Nothing about this ADR re-introduces it. The TUI is the host for the chat playground, not the CLI. Users who want the chat agent run the TUI; users who want a scripted CLI do not get an embedded agent.

## References

- Issue `pattern-stack/codegen-patterns#31` — Bubble Tea TUI proposal
- ADR-015 — CLI Command Architecture (noun-verb; the command surface being gated)
- ADR-016 — CLI UI System (`--json` mode, `@clack/prompts`; the CLI safety vocabulary)
- ADR-018 — Consolidate Interactive Surface on Bubble Tea (why the chat playground lives in the TUI, not the CLI)
- `src/cli/shared/git-safety.ts` — `checkGitSafety()` — authoritative working-tree guard
- `src/cli/commands/entity.ts`, `src/cli/commands/subsystem.ts`, `src/cli/commands/dev.ts` — the actual gates the allowlist wraps
- `pattern-stack/chat-patterns` `_examples/claude-code/main.go` — the adapter pattern this ADR's enforcement point lives inside
