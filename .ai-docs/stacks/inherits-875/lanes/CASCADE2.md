# Lane `inh-cascade2` — cascade the Gate 2.5 decision commits up the #875 stack

Read `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/lanes/COMMON.md` first. It binds you: public
repo, no sub-agents, **never push**, never merge.

Each of the six stack branches got Gate 2.5 **decision** commits (Doug's D1–D17, `lanes/DECIDE.md`) on top of its own tip. They were made in parallel, so each upper
branch still contains its parent's **pre-fix** commits. Your job is to replay each branch's own commits onto its
**fixed** parent, bottom-up, so the stack is linear again with every fix in place.

| Branch | Worktree (`/Users/dug/Projects/worktrees/codegen-patterns/…`) | Old parent tip (pre-fix) |
|---|---|---|
| `dugshub/875-s1-inherits-schema` | `dugshub-875-s1-inherits-schema` | `origin/main`, already on it, nothing to do |
| `dugshub/875-s2-inherits-ddl` | `dugshub-875-s2-inherits-ddl` | `b5323f64` |
| `dugshub/875-s3-inherits-reads` | `dugshub-875-s3-inherits-reads` | `c8c9db75` |
| `dugshub/875-s4-inherits-writes` | `dugshub-875-s4-inherits-writes` | `5b47af03` |
| `dugshub/875-s5-inherits-http` | `dugshub-875-s5-inherits-http` | `3989c963` |
| `dugshub/875-s6-inherits-frontend` | `dugshub-875-s6-inherits-frontend` | `cb080bc4` |

For each branch from S2 to S6, in order, **inside that branch's own worktree**:

1. Make sure the tree is clean (`git status --short`), then keep a backup: `git branch -f backup/cascade2-<sN> HEAD`.
2. Run `git rebase --onto <fixed parent branch> <old parent tip>`.
3. **Resolve every conflict by keeping both intents**: the parent's Gate 2.5 fix *and* this branch's change.
   - Read both decision notes: `/Users/dug/Projects/dug/codegen-patterns/.ai-docs/stacks/inherits-875/gate25/<PR>-decisions.md`
     for the parent PR and for this one. `lanes/DECIDE.md` has the full decision list.
   - Shared files will conflict: `docs/rfcs/RFC-0006-joined-table-inheritance.md`, `entity-locals.js`, `repository.ejs.t`,
     `service.ejs.t`, `src/derived/api/*`, `src/schema/inheritance.ts`, and the goldens and snapshots.
   - Goldens, snapshots and baseline files: **do not hand-merge them; regenerate them** with the repo's own update flags
     (`UPDATE_*` env or `--update-snapshots`, as each test documents) once the code compiles. Check that the diff against
     the pre-cascade branch is explained by the parent's fixes.
   - When a parent fix renamed or moved something this branch also uses (a kind, a helper, a name rule), carry the
     rename into this branch's code. Never reintroduce the old form.
4. After the rebase, on that branch's tip, run `bun run typecheck`, `just test-unit` and `just test-baseline` before you
   go on to the next branch. If a gate is red, fix it on **this** branch, as a commit marked
   `fix(#875 S<n>): cascade — …`, and say why.
5. Go on to the next branch only when the current one is green.

**Do not** use `gh stack rebase`. Every branch is checked out in its own worktree, so it can't switch between them. The
coordinator re-adopts the stack and pushes afterwards.

## Report

`SendMessage` to `codegen-patterns-73` (hc terminal `t1rf`). For each branch, give:
- the new tip sha;
- each conflict, and how you resolved it;
- any cascade fix commit;
- the tails of the three gates.

Then stop.

## Known for this round

- **The `document` fixtures:** S3 committed the scaffold-only `document` / `report_document` YAMLs and the
  `schema.ts` export. S4 and S5 had committed copies of S3's staged bytes. On an add/add conflict, take **S3's**
  version, and make S4's and S5's tests follow it if they differ.
- **RFC ownership:** S1 rewrote §4.1 / §4.2 (the base repository owns `KindRequiresChildError`, D16) and added §11.3.
  An upper branch's older text for those lines loses; its own §13.2 as-built notes win.
- **S4's derived kinds:** S4 renamed the service `kind_guard` to a repository `create_guard` (D16). Carry that into
  S5's and S6's code and Studio kind tables if they reference the old kind.
