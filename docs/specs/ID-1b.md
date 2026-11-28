# ID-1b: the workspace operations as commands

**Status:** implemented · **Follows:** ID-1 (#987), H-1 (#986)

## Problem

Under pattern-stack, every way in (HTTP under `http: hono`, MCP tools, a CLI) reads one table of commands,
`<generated>/commands.ts`. Identity's entities are left out of it on purpose (`generate.commands: false`): a generic
`workspace list` would read every tenant's workspaces, and a generic membership write would skip the rights table and
the cache invalidation. So the workspace operations, which live only on `app.module('workspaces').service`, could not be
reached by any way in.

## Decision

Five hand-written commands in the identity runtime (`runtime/subsystems/identity/workspace-commands.ts`, exported from
`identity/core.ts`), each a `defineCommand` over the `workspaces` module (`{ service }`), built for the project by
`workspaceCommandsFor({ source, limits })`:

| Command | Input | Effect | Runs | HTTP |
|---|---|---|---|---|
| `workspace create` | `{ name, slug }` | side-effect | `createWorkspace` | `POST /workspaces` (body), 201 |
| `workspace list-mine` | `{}` | read | `listMine` | `GET /workspaces/mine`, 200 |
| `membership add` | `{ userId, role }` | side-effect | `addMember` | `POST <prefix>/memberships` (body), 201 |
| `membership change-role` | `{ userId, role }` | idempotent | `changeRole` | `PATCH <prefix>/memberships/:userId` (role in the body), 200 |
| `membership remove` | `{ userId }` | side-effect | `removeMember` | `DELETE <prefix>/memberships/:userId`, 200 |

- **Inputs are Zod schemas**, checked by `invokeCommand` before the service runs: `userId` is a `z.guid()`, `role` one
  of `ROLES`, and a workspace's `name` and `slug` are at most the project's own `workspace.yaml` `max_length`s. The
  composition reads them from the vendored YAML (as it checks `membership.yaml`'s role choices) and prints them into the
  commands table; a `workspace.yaml` without them is refused. So a value its column can't hold is `invalid-input` naming
  the field, never the database's truncation error, whatever the author set.
- **Each `run` is `attempt(…)`** from `runtime/commands.ts`, so the service's errors are refusals by its one table:
  401 `unauthenticated`, 403 `forbidden`, 404 `not-found`, 409 `conflict` (`already_a_member`, `last_owner`), 400
  `bad-request` (`workspace_required`), and a taken slug `unique-violation`. Each carries the Nest body. A crash still
  throws.
- **The requester comes from the request state**, as for the service. A way in resolves the requester with the port and
  runs `invokeCommand` inside `withRequester(requester, …)`; a job or an agent uses `requesterFor`.
- **Each is routed** (the Hono lane's ask): it carries `http`, a `CommandHttp` (`runtime/commands.ts`), the one shape:
  a derived command's `EntityCommand['http']` is that type. Its route is its `WORKSPACE_ROUTES` row (`names.ts`) and its
  status `NEST_SUCCESS_STATUS[verb]` (moved to `runtime/commands.ts`, which the derivation imports), so H-2 mounts these
  through the same view as the generated routes, inside `withRequester(resolved)`; a command without `http` isn't
  routed. `<prefix>` is the workspace source's `routePrefix`: `''` for `header`, `/w/:workspaceId` for `path`, where the
  requester port reads the workspace from (it is not an input field). The workspace itself is created and listed at the
  root.
- **The routes can't collide with an entity's.** Each starts with a plural of identity's own entities (`workspaces`,
  `memberships`; both `api: false`). A generated route starts with its entity's plural, and a second entity with one of
  those plurals is already refused by the class graph, naming both. A project's own `member` entity (`/members`)
  composes beside them.
- **The table lists them** when identity is composed. Identity's share of `<generated>/commands.ts` is one record
  (`identityCommands`: a doc line, imports, entries; the table joins a list of such hand-written shares):
  `...allOnApis(workspaceCommandsFor({ source: workspaceSource, limits: { name, slug } }), (app: App) => app.module('workspaces'))`.
  `workspaceSource` is exported by the requester system, built once from its registry row, so the routes' prefix and the
  source the requester resolves through are the same object. The table is typed `readonly AppCommand[]`
  (`Command<App> & { readonly http?: CommandHttp }`), so a reader gets `http` without a cast.

## Not in this step

- Commands for users: today the app creates users through the generated `user` use cases.
- Mounting the routes: H-2's (the Hono lane's).
- Idempotency keys: no command reads `ctx.idempotencyKey` yet (H-1d).

## The gate

- `src/__tests__/runtime/subsystems/identity/workspace-commands.test.ts`: the five names and effects; create, list,
  add, change and remove through `invokeCommand`; every schema refusal names its field and never reaches the service;
  the limits passed are the ones checked (one over refused, at the limit accepted); each service refusal's reason,
  `instead` and body; a crash throws. The fake service is shared with the ID-1 tests (`fake-workspaces.ts`).
- Routes: each command's verb, path and status under both sources, each under identity's own plurals, every bound field
  an input field and every path field a `:param`, the status `NEST_SUCCESS_STATUS`'s; the binding survives `allOnApis`.
- `src/__tests__/cli/identity-pattern-stack.test.ts`: the commands table's identity entry (the requester system's
  `workspaceSource`, the YAML's limits) and its `AppCommand` type; an edited `max_length` is the one printed; a missing
  one is refused; a `members` entity composes; a second `memberships` or `workspaces` entity is refused by name.
- The smoke's Postgres leg (`crud-check.ts`, `workspaceCommandsCheck`): each command through `commandNamed` and
  `invokeCommand`, inside the requester the port resolved from the request's headers, with a refusal each (a taken
  slug, a slug over the YAML's limit, nobody signed in, a second add, a member adding, demoting the last owner, a role
  that isn't one, a second remove), a removed member refused at once, and the table's typed `http` read without a cast.
  With the table's line removed from the composition, it fails.

## As built (#989's review)

- The limits are the project's `workspace.yaml`'s, printed by the composition (they were a runtime constant checked only
  against the shipped YAML).
- The membership routes moved from `<prefix>/members` to `<prefix>/memberships`, so a project's own `member` entity
  can't sit on them. A separate route-collision refusal turned out to be unreachable (the class graph already refuses a
  second entity with identity's plurals), so the gate proves that refusal instead.
- `CommandHttp` is the one owner of the HTTP binding's shape; the assignability check (which missed an added optional
  field) is gone.
