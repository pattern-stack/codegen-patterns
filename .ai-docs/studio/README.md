# Studio — how to run it

One browser window with the model graph, the YAML and generation in it. Local only, no auth, no remote projects.

Spec: `docs/specs/STUDIO-0.md`. Issue: #698.

---

## Two commands

```bash
just studio-demo     # build the demo project (~2s, safe to re-run — it resets)
just studio          # start the server + UI, then open the printed URL
```

`just studio-demo` materializes a small consumer project: three entities (`account`, `contact`, `opportunity`), the
generated NestJS modules for them, and one baseline git commit. `just studio` points the Studio at it.

**Neither command needs Docker, a database, or a `bun add`** — I ran `just studio-demo` on a clean tree in 1.9s and
it reports `database: not configured`. Generation writes TypeScript and never connects to a database.

The one exception is Studio's **`DB push`** run step, which needs a real Postgres. If you want it, build the demo
with the other recipe instead:

```bash
just studio-demo-db  # same demo project + compose-up Postgres + pinned drizzle-kit/orm
```

It is a separate recipe rather than a flag, so the documented path cannot quietly reacquire a Docker dependency,
and it fails early with a pointer back to `just studio-demo` when Docker isn't running. Nothing else in the
walkthrough requires it. `just test-studio` needs neither, and materializes its own copy of the demo project.

---

## Reaching it from another machine

Studio binds `127.0.0.1` by default. If you are working on a remote box, **prefer an SSH tunnel** — nothing is
exposed and Studio stays on loopback:

```bash
ssh -L 5178:127.0.0.1:5178 <host>     # on your laptop
codegen studio                        # on the host, unchanged
# then browse http://127.0.0.1:5178 on the laptop
```

Only if you must bind an address something else can reach (a tailnet, a LAN):

```bash
codegen studio --host 10.0.0.5 --port 5178
codegen studio --host 10.0.0.5 --allow-origin http://box.tailnet.ts.net:5178   # reached by NAME
```

**That second form exposes an unauthenticated API.** Anyone who can reach the address can read and write this
project's YAML and run generate / dbPush / restart in it. A tailnet, not a café. The server says so itself on
startup, and it is worth reading rather than scrolling past:

```
[WARN] Studio is bound to 10.0.0.5:5178, which is reachable from other machines.
[WARN] The API is UNAUTHENTICATED: anyone who can reach this address can read and
[WARN] write this project's YAML and run generate / dbPush / restart in it.
[WARN] Prefer an SSH tunnel (ssh -L 5178:127.0.0.1:5178 <host>) and the default
[WARN] loopback bind, or restrict who can reach this address.
```

`--allow-origin` is only needed when a browser reaches the server **by name** rather than by address, because the
`Origin` header then carries the name. It takes exact origins, repeatable; there are no wildcards.

Both `just studio` paths work over a remote bind — the built UI and the Vite dev server alike, since the browser
only ever talks to the Studio server and the server→Vite hop stays on loopback. Pointing a browser *straight* at
Vite from another machine does not work, deliberately: Vite is an unauthenticated dev server with filesystem
access, and binding it off-box to save one hop would be a worse hole than the one the origin check closes.

---

## The demo, in about ninety seconds

The demo set has a deliberate hole: **`contact` and `opportunity` are not linked**. Both hang off `account`, and
nothing connects a person to a deal. Filling that hole is the walkthrough.

1. **Look at the graph** ([1-model-graph.png](1-model-graph.png)). `3 nodes · 4 edges` — `account` to each of the
   others and back. Nothing between `contact` and `opportunity`.
2. **Click a node** ([2-node-selected.png](2-node-selected.png)). The inspector's Detail tab shows its fields,
   badges, behaviors and source path.
3. **Open the YAML tab and break something on purpose**
   ([3-yaml-validation-error.png](3-yaml-validation-error.png)). The tab grows a red issue count, the offending
   line gets a marker, and the issue is spelled out underneath. Nothing is written to disk while it is invalid —
   `Revert` puts it back.
4. **Add the missing relationship in the Relate tab**
   ([4-relationship-form-preview.png](4-relationship-form-preview.png)). `contact` → `opportunity`, kind
   `many-to-many`, types if you want them. **Preview** shows the YAML it would write
   (`relationships/contact_opportunity.yaml`) without writing it; **Save** writes it and says
   *“Wrote 1 file. Run Generate to build it.”*
5. **Click Generate** ([5-generate-streaming.png](5-generate-streaming.png)). The log streams as it runs. If you
   built the demo with `just studio-demo-db`, tick `DB push` too and the tables land in Postgres — `drizzle-kit`
   reports `Changes applied` at the end of the log.
6. **Read the diff** ([6-generate-diff.png](6-generate-diff.png)). **14 files**: the new relationship YAML, the
   **11** files of `src/modules/contact-opportunities/` (Drizzle table, repository, service, controller, module,
   three DTOs, two use-cases, barrel), and the two regenerated barrels under `src/generated/`. Click a file to
   see its patch. Everything in that list is a consequence of the link you just added — nothing unrelated.

7. **Back to the graph** ([7-graph-after-generate.png](7-graph-after-generate.png)). The header now reads
   `1 relationship` and the canvas `4 nodes · 6 edges`: `ContactOpportunity` has appeared as its own ◇ junction
   node, badged `temporal` `sourced`, joined to `contact` and `opportunity` by junction edges.

That is the loop the issue asked for, minus its last hop.

**A counting note, so the numbers don't look wrong.** The API reports the new link as *one* `N:M` edge
(`contact → opportunity`) and the graph as 5 edges; the canvas draws the relationship as a **node** with an edge to
each endpoint, so it says 6. Both are right — a first-class relationship carries its own fields, so the canvas gives
it somewhere to put them. `just test-studio` asserts the API's numbers.

---

## What each pane does

Every pane below was driven in a browser before it was written down, and the screenshots in this directory
(`1-model-graph.png` … `8-server-down.png`) are states the UI actually reached, in the order a demo reaches
them.

**Layout.** A fixed header: project path, CLI version, `N entities · N junctions · N relationships`, the three
run-step checkboxes (Generate / DB push / Restart), `Reload` and `Generate`. The graph fills the left; a
resizable inspector column is on the right (drag its left edge) and a resizable drawer along the bottom (drag
its top edge). Nothing resizes itself, so a streaming run never shifts anything above it.

**Model graph.** Entity and junction cards laid out with elk, each showing its fields with pk/fk markers and
its behaviour badges; a junction also shows `from ↔ to` and its `temporal` / `sourced` flags. Clicking a card
dims every node and edge it doesn't touch and opens it in the inspector; clicking empty canvas clears that.
Above the canvas sit a text filter over names, fields and types, and one chip per pattern with counts.
Bottom-left is the edge legend — `belongs_to`, `has_many`, `has_one`, `junction`, `role` — generated from the
same table that draws the edges, so it cannot drift. It starts collapsed to a chip on a laptop-width canvas and
expanded on a roomy one, so it never sits on top of a node ([9-laptop-1280x720.png](9-laptop-1280x720.png)). The minimap appears only above
12 nodes, below which it would cover a card it duplicates.

**Inspector → Detail.** The selected entity's pattern, plural, fields with per-field badges (`FK`, `req`,
`null`), behaviours, the source YAML path, and field/query counts.

**Inspector → YAML.** CodeMirror 6 over the selected file, with a file picker, `Revert` and `Save`; ⌘S / Ctrl-S
saves too. On a rejected save the server's issues render on the lines they belong to — gutter marker, wavy
underline, and a list below where each row is `line:col` plus the message, and clicking a row jumps to it. The
tab carries an issue count. Unsaved edits mark the tab, and block both switching files and leaving the page
without confirming. Nothing invalid reaches disk.

**Inspector → Relate.** `From` and `To` pickers with the cardinality between them, one row per kind with a
one-line description, and then **only the options that kind actually has** — `many-to-many` offers Through /
Name / Types / Temporal / Sourced, `belongs_to` offers Name / Inverse / Required / On delete. Below that, the
YAML the server would write, refreshed as you type, and `Save`. Everything kind-dependent comes from one
registry, including the request itself, so an option set under a previous kind is dropped rather than sent.

**Drawer → Log.** A fixed step strip (Generate / DB push / Restart, greyed until each reports) above the
streamed output. It follows the tail unless you scroll up, and stops following until you scroll back down.

**Drawer → Diff.** The file list on the left with status letters and `N files +A −B`; the selected file's patch
on the right with old/new line numbers and added/removed colouring. Long generated paths truncate from the
left so the filename stays readable.

## What is NOT built

**The data explorer.** Slice 3 of #698 — records browsable, links attach/detach, the instance graph live — does not
exist. The demo stops at "see the new edge in the model graph". You cannot follow the relationship onto real records,
because nothing embeds the generated frontend yet.

Note the database is **not** what is missing. Build the demo with `just studio-demo-db` and the `DB push` step
works end to end — I ran `{"steps":["generate","dbPush"]}` against it and drizzle-kit reported `Changes applied`,
with `accounts`, `contacts` and `opportunities` present in Postgres afterwards. What slice 3 needs is the UI for
browsing what is in those tables.

Also not built, smaller:

- **The `restart` run step has nothing to restart.** It is wired and runs `codegen dev restart`, and it reports
  `ok` — but the demo project installs no NestJS packages, so there is no app to bring up and the log says
  `app restarted (PID …) but not responding yet`. The step works; the demo just isn't a runnable server.
  (`DB push` **does** work, with `just studio-demo-db` — see below.)
- **A cancel for a wedged run.** One run at a time is enforced; a second Generate while one is in flight is refused.
  If a run's subprocess hangs, every later Generate is refused until you restart the server. STUDIO-0 §7.4.
- **Whole-project validate.** `POST /api/validate` exists in the contract; the editor validates per file and nothing
  drives the project-level route. STUDIO-0 §7.2.
- **Any browser-level gate.** `just test-studio` proves the HTTP loop, the server's dev-serving contract and the
  UI's pure units. Nothing in CI renders a pane, so a change that breaks the layout passes every gate.
  STUDIO-0 §7.1.
- **The `role` edge kind, against real data** (#709). It is implemented and in the legend, but no demo entity
  declares `roles:`, so `belongs_to` / `has_many` / `junction` are the only kinds the demo and the test confirm.
  This is **not** a one-line fixture add: `roles:` requires the declaring entity to carry `Communication` and the
  target to carry `Actor`, so it needs a fourth entity (none of account / contact / opportunity is honestly a
  communication entity), and the capability mixins resolve through `@shared/*`, which the demo's package runtime
  mode does not provide. Worth knowing because roles are the headline of the active project (#578) — the demo
  currently cannot show the thing it most exists to demonstrate.

If the API is unreachable the app says so and offers Retry ([8-server-down.png](8-server-down.png)) rather than
rendering an empty graph — worth knowing, so you can tell "the server died" from "the project has no entities".

---

## If something looks wrong

**Saves fail with 403 after you bound a reachable address.** Expected, and the fix is one flag. The server
accepts only origins matching the address it actually bound, so if you reach it **by name**
(`http://box.tailnet.ts.net:5178`) while it is bound to an address, the browser's `Origin` carries the name and
is refused. Restart it with `--allow-origin http://box.tailnet.ts.net:5178`. The startup line
`accepted origins: …` tells you exactly what it will take. Reads keep working, which is why this shows up as
"the graph loads but nothing saves".

**The graph is empty.** The server is pointed somewhere without an `entities/` directory. Check the path it printed at
startup, and that `just studio-demo` finished.

**Generate fails with `Uncommitted changes in N generated-output files`.** It should not — the Studio passes `--force`
on both generate legs precisely so a dirty tree is fine. If you see this, the run is shelling the CLI without
`--force`; that is a bug, not a state you need to clean up.

**The diff shows a bare directory instead of files.** Same class: the diff must enumerate untracked files
individually (`git status --porcelain -uall`). A collapsed `src/modules/contact-opportunities/` with no patch means it
is not.

**The demo project drifted.** Re-run `just studio-demo`. It resets the directory — **anything you left in there is
gone**, so do not keep real work in the demo project.

---

## Running the test

```bash
just test-studio
```

Boots the real server against a throwaway copy of the demo project and drives the whole loop over HTTP — graph, a
rejected YAML edit with the exact schema error, the fix, the relationship preview and write, Generate consumed to the
end of its stream, then the new edge in the graph and the new module in the diff. It takes seconds and needs no
Docker.

It runs in its own private TMPDIR, so it is safe to run while other gates are running (#691). `KEEP_STUDIO_DIR=1`
keeps the project it built; a failure keeps it anyway and prints the path.

What it does **not** check: that the generated code compiles (that is `just test-smoke`), and anything in the browser.
