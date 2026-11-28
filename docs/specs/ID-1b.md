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
`identity/core.ts`), each a `defineCommand` over the `workspaces` module (`{ service }`):

| Command | Input | Effect | Runs | HTTP |
|---|---|---|---|---|
| `workspace create` | `{ name, slug }` | side-effect | `createWorkspace` | `POST /workspaces` (body), 201 |
| `workspace list-mine` | `{}` | read | `listMine` | `GET /workspaces/mine`, 200 |
| `membership add` | `{ userId, role }` | side-effect | `addMember` | `POST <prefix>/members` (body), 201 |
| `membership change-role` | `{ userId, role }` | idempotent | `changeRole` | `PATCH <prefix>/members/:userId` (role in the body), 200 |
| `membership remove` | `{ userId }` | side-effect | `removeMember` | `DELETE <prefix>/members/:userId`, 200 |

- **Inputs are Zod schemas**, checked by `invokeCommand` before the service runs: `userId` is a `z.guid()`, `role` one
  of `ROLES`, and a workspace's `name` and `slug` are at most `WORKSPACE_FIELD_MAX` (`workspace.yaml`'s `max_length`s;
  a test holds the shipped YAML to them). So a malformed input is `invalid-input` naming the field, never the database's
  truncation error.
- **Each `run` is `attempt(…)`** from `runtime/commands.ts`, so the service's errors are refusals by its one table:
  401 `unauthenticated`, 403 `forbidden`, 404 `not-found`, 409 `conflict` (`already_a_member`, `last_owner`), 400
  `bad-request` (`workspace_required`), and a taken slug `unique-violation`. Each carries the Nest body. A crash still
  throws.
- **The requester comes from the request state**, as for the service. A way in resolves the requester with the port and
  runs `invokeCommand` inside `withRequester(requester, …)`; a job or an agent uses `requesterFor`.
- **Each is routed** (the Hono lane's ask): it carries `http`, a `CommandHttp` (`runtime/commands.ts`), which is the
  derived commands' `EntityCommand['http']` structurally; a type check beside the commands table's emitter
  (`COMMAND_HTTP_IS_DERIVED_HTTP`) fails `tsc` if either changes alone. So H-2 mounts these through the same view as the
  generated routes, inside `withRequester(resolved)`; a command without `http` isn't routed. The success status is
  Nest's rule (POST 201, else 200). `<prefix>` is the configured workspace source's `routePrefix` row: `''` for
  `header`, `/w/:workspaceId` for `path`, where the requester port reads the workspace from (it is not an input field).
  The workspace itself is created and listed at the root.
- **The table lists them** when identity is composed: `<generated>/commands.ts` imports `workspaceCommandsUnder` and
  `WORKSPACE_SOURCES` from the identity entry and adds
  `...allOnApis(workspaceCommandsUnder(WORKSPACE_SOURCES['<workspace_from>']()), (app: App) => app.module('workspaces'))`
  after the generated entries: the source is its registry row, picked by name, never a branch. `onApis` keeps `http`
  (it spreads the command), so the table's entries carry it; the table's type (`Command<App>`) doesn't name it yet.

## Not in this step

- Commands for users: today the app creates users through the generated `user` use cases.
- Mounting the routes: H-2's (the Hono lane's).
- Idempotency keys: no command reads `ctx.idempotencyKey` yet (H-1d).

## The gate

- `src/__tests__/runtime/subsystems/identity/workspace-commands.test.ts`: the five names and effects; create, list,
  add, change and remove through `invokeCommand`; every schema refusal names its field and never reaches the service;
  each service refusal's reason, `instead` and body; a crash throws; the limits match the shipped YAML. The fake
  service is shared with the ID-1 tests (`fake-workspaces.ts`).
- `src/__tests__/cli/identity-pattern-stack.test.ts`: the commands table lists them on the `workspaces` module, under
  the fixture's configured source (`path`).
- Routes: each command's verb, path and status under both sources; every bound field is an input field and every path
  field a `:param`; the binding survives `allOnApis`. `COMMAND_HTTP_IS_DERIVED_HTTP` fails `tsc` when the two shapes
  differ (proved with a third success status).
- The smoke's Postgres leg (`crud-check.ts`, `workspaceCommandsCheck`): each command through `commandNamed` and
  `invokeCommand`, inside the requester the port resolved from the request's headers, with a refusal each (a taken
  slug, nobody signed in, a second add, a member adding, demoting the last owner, a role that isn't one, a second
  remove), and a removed member refused at once. With the table's line removed from the composition, it fails.
