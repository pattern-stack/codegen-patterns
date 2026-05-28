# ADR-035 — Consumer Skill Distribution

**Status:** Accepted
**Date:** 2026-05-27
**Owner:** Doug
**Related:** ADR-030 (Progressive Disclosure for Project Skills), ADR-008 (Subsystem Architecture)

## Context

ADR-030 established how *this repo's* skills are authored: progressive-disclosure
`.claude/skills/*`, frontmatter, living documentation. Those skills are
**dev-facing** — they help an agent develop `@pattern-stack/codegen` itself, and
they cite internal artifacts (`docs/adrs/*`, `docs/specs/*`, issue numbers).

But the package's *consumers* — agents working in a separate NestJS + Drizzle app
that uses the generated code — have none of that knowledge. A consumer's coding
agent doesn't know the entity-YAML schema, the subsystem `forRoot` registration
order, how to author a `@JobHandler`, or that the event-to-job bridge needs its
reserved pools polled. The dev skills can't simply be shipped as-is: their
internal citations are dead links in a consumer repo, and their framing is
"developing the package," not "using it."

Two questions: **what** consumer skills exist, and **how** they reach a consumer
project.

The package already vendors runtime *code* into consumers (`src/shared/**`, via
`project init`) rather than relying on `node_modules` imports — see the
VENDORED_RUNTIME_FILES rationale in `init-scaffold.ts` (the dual-drizzle
type-identity clash). Skills are a natural parallel: managed files the consumer
owns a copy of, refreshed on upgrade.

## Decision

### Delivery: CLI vendor-copy (not a plugin)

Consumer skills ship inside the npm package under a top-level `consumer-skills/`
directory (added to `package.json` `files`). A `skills` CLI noun vendors them
into the consumer's `.claude/skills/`:

```
codegen skills install     # vendor-copy consumer-skills/* → .claude/skills/
codegen skills list        # available vs installed
```

`project init` runs the install by default (opt out with `--no-skills`), and
`codegen update` re-syncs them after a package bump. The copy is drift-aware
(created / updated / unchanged) and gated on git-cleanliness the same way
`subsystem install` is.

Rejected alternative: shipping skills as a separate **Claude Code plugin** the
consumer adds via a marketplace. It offers cleaner central updates but requires
plugin/marketplace plumbing and a second opt-in step decoupled from the npm
dependency. Vendor-copy matches how runtime is already delivered, works offline,
and re-syncs through the same `codegen update` consumers already run. A plugin
remains a possible future addition; it is not needed for the 90% case.

### Content: authored fresh, consumer-framed

The consumer skills are **authored fresh** for a consumer audience, not the dev
skills shipped verbatim. They reuse the dev skills and `docs/CONSUMER-SETUP.md`
(itself already consumer-framed) as raw material, but:

- strip every internal citation (`ADR-0NN`, `docs/specs/*`, issue numbers) —
  replaced with the actual concept or a link to a sibling consumer skill;
- frame everything as "using the package in *your* app";
- import runtime symbols from the vendored `@shared/*` paths consumers actually
  have.

They follow the ADR-030 shape: a `codegen` L0 router that points at focused
`entities`, `subsystems`, `jobs`, `events`, `bridge`, and `sync` skills, with
frontmatter and `user-invocable: false`. Each vendored file carries a
`managed by @pattern-stack/codegen` header so reviewers know it's generated
output and `codegen update` may overwrite it.

The `subsystems` skill additionally documents the subsystem dependency +
`forRoot` registration order (bridge after events+jobs; observability last;
auth before auth-integrations). This is knowledge the CLI does **not** yet
enforce (see "Deferred" below) — the skill is the source of truth in the
interim.

### Authoring is grounded against the runtime, not the docs

While authoring, several examples in `docs/CONSUMER-SETUP.md` were found to be
stale against the actual runtime (`JobsModule.forRoot` vs the real
`JobsDomainModule` + `JobWorkerModule`; `implements IJobHandler` vs `extends
JobHandlerBase`; `concurrency_key` vs `concurrency: { key }`). The consumer
skills were written against the **runtime source**, which is authoritative. This
is itself an instance of the ADR-030 living-documentation rule — CONSUMER-SETUP
should be reconciled to match.

## Consequences

**Positive**
- A freshly-`init`'d consumer project has discoverable, accurate agent skills
  with zero extra setup.
- One `codegen update` refreshes runtime *and* skills together; no marketplace.
- The `consumer-skills/` set is a single, reviewable source authored against the
  runtime, decoupled from the dev `.claude/skills/`.

**Negative**
- Two skill sets to maintain (dev-facing `.claude/skills/`, consumer-facing
  `consumer-skills/`). Drift between them is possible; mitigated by both being
  living documentation updated alongside the code they describe.
- Vendored skills can be locally edited by a consumer; `codegen update`
  overwrites divergent copies (git is the review/rollback net). The managed
  header tells the reader not to hand-edit.

**Neutral**
- Skills add to the npm tarball size (markdown only — negligible).

## Deferred

The subsystem dependency graph is currently encoded only in prose (this ADR, the
`subsystems` consumer skill, `printInfo` hints). A follow-up will lift it into
data on the subsystem descriptors and add `subsystem add` (topological install),
`subsystem order` / `doctor` (validate registration order), and a real
`subsystem remove`. The consumer `subsystems` skill already teaches the order so
agents benefit before the CLI enforces it.

## References

- ADR-030 — progressive-disclosure skill convention these consumer skills follow
- `consumer-skills/` — the authored set
- `src/cli/commands/skills.ts` — the `skills` noun + `runSkillsInstall`
- `src/cli/commands/project-update.ts` — `codegen update` (re-syncs skills + runtime)
