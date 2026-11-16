# Lane brief — STUDIO-5: dbt-style selectors in the canvas filter, double-click to focus

You are a **build lane for one PR** off `main`, owner-approved ("GO") on 2026-11-15. A separate lane is fixing an
API-tab bug in parallel in another worktree; don't touch it.

- **Worktree:** `/Users/dug/Projects/worktrees/codegen-patterns/dugshub-studio-5-selectors`, branch
  `dugshub/studio-5-selectors`, on `main` @ `a86e3a3d` (0.34.0). Run `mise trust && just install` first.
- **Lead (me):** session `dugshub-api-surface-a0-1e`, hc terminal `t1t9`. Report with `SendMessage`; if that doesn't
  resolve, use `ListAgents` and look for a name starting `dugshub-api-surface-a0-`.
- **Background reading:** `CLAUDE.md` § Studio (the tree canvas, spine and secondary lines, the packing and docking
  rules, `fitAvoidingCorner`). Then `tools/studio/src/graph/GraphPane.tsx`: the filter box is `query`, fed to
  `useGraphFilter`.

## The owner's spec (do not widen it)

1. **Selectors in the canvas filter box (dbt-style).** Per token:
   - **Forms:** `name`, `+name`, `name+`, `+name+`, `N+name`, `name+N`, and both sides combined, e.g. `2+name+3`.
   - **Space-separated tokens are a union.**
   - **`name+`** = the entity plus what *depends on it*: its children, the entities whose FK points at it.
   - **`+name`** = the entity plus what *it depends on*: its parents.
   - **Depth:** a number limits the hops; a bare `+` means unlimited.
   - **A token without `+`** keeps today's text-filter behaviour, and its matches join the union.
   - **An unknown entity name** in a selector shows an **inline message** by the box. Never a silent empty canvas.
2. **Hops follow every line:** spine, secondary, `inherits`, role.
   - A **junction or relationship node** counts as **one** hop between its endpoints, and the junction node is shown.
   - Direction: a line's child end depends on its parent end. Use the edges' own parent/child (as the tree layout
     does). For `inherits`, the child depends on its base. For a role, check how the adapter orients it, and state
     the rule you used.
3. **Double-click a card** → the box is set to `1+<name>+1` (visible and editable).
   - **Esc** in the box, or clearing it, restores everything.
4. **The visible subset is re-laid out as its own tree**, with the same tidy-tree, wrapping and docking rules
   (`layout/tree-layout.ts` on the subset), and refit with the legend-aware fit (`fitAvoidingCorner`).
   - Hidden cards are **removed from layout**, not just dimmed.
5. **The parser is a pure module** (e.g. `tools/studio/src/graph/selector.ts`), with unit tests for:
   - grammar, including malformed tokens;
   - direction;
   - depth;
   - union;
   - the junction hop;
   - the inherits hop;
   - an unknown name.

   **Mutations**, each red, then reverted:
   - swap up/down → red;
   - ignore the depth → red.

   Plus **one test that double-click sets the selector**: a component test, or the e2e harness if it can.
6. **Docs:** `CLAUDE.md` § Studio and `docs/specs/STUDIO-0.md` get the grammar, the direction rule and the hop rules.

Studio-only scope: `tools/studio/src/**` and those two docs.

## Sign-off page (you build the HTML; the lead publishes)

**Shots**, light and dark, at 1440×900:
- (a) before, the full canvas;
- (b) a double-click focus (`1+<name>+1`) on a card with both parents and children;
- (c) a `name+2` selector;
- (d) the unknown-name message.

Take each on two models: the **Studio demo** (`just studio-demo <dir>` builds one) and the **joined-table-inheritance
fixture** (`test/fixtures/inheritance/`; copy it into your scratchpad as a project).
- Run Studio with `just studio <dir> 6377 6378`, and point the browser at the **server port 6377**, never the Vite
  port: Vite's `/api` goes to 5178, which is another session's server.
- Check `/api/health` `projectDir` before shooting.
- **Don't touch** hc terminal `studio-900` or ports 5977/5978.
- Stop your server afterwards.

**The page.** Write one HTML file in your scratchpad, in the style of the lead's builder
`/private/tmp/claude-501/-Users-dug-Projects-worktrees-codegen-patterns-dugshub-api-surface-a0/e4d7824a-677e-46d0-8d28-c17dcb28583a/scratchpad/s7/build_studio4.py`.
Read it, then copy its approach:
- the style block taken from `s3/page.tpl.html`;
- light/dark image pairs, JPEG data URIs;
- the lightbox;
- `<title>Studio Selectors</title>`.

Its sections:
- what's new;
- the grammar as a small table: token → what it shows;
- the shots, with honest captions;
- decisions you made, such as the role direction and how malformed tokens are treated;
- the gate outputs and mutations.

Report its path; don't publish it.

## Rules (binding)

- **No sub-agents. No commit, push, PR, merge or `gh stack`.** Leave the work uncommitted; the lead commits.
- **Public repo — private-context rule.** This repo is public. Never put host-application names, paths, table names or
  "dogfood" references in code, comments, tests or docs; say "a host application". Unit-test fixtures use **generic
  names of your own**.
- Never weaken anything existing: no `.skip`/`.todo`/`.only`, no type escapes. List any changed pre-existing assertion.
- Tokens only; no colour literals.
- **Stop and report** on any design question this brief doesn't answer. Two failed attempts at the same gate is also
  a stop.

## Exit (final tree)

1. `just test-studio` → 0. Report the UI test total.
2. `git diff -- tools/studio/src/__tests__ | grep -n '^-.*expect('` → only lines you list.
3. Colour-literal grep over the diff → no output, or issue references only.
4. Mutations: swap direction → red; ignore depth → red. Paste the lines.

## Report (SendMessage to `dugshub-api-surface-a0-1e`)

Short:
- Files changed.
- Each exit step → the deciding line.
- The mutations' red lines.
- Your decisions.
- The page path and the shot list.
- Anything you could not do.

Then stop and wait.
