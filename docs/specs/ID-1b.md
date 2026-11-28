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

| Command | Input | Effect | Runs |
|---|---|---|---|
| `workspace create` | `{ name, slug }` | side-effect | `createWorkspace` |
| `workspace list-mine` | `{}` | read | `listMine` |
| `membership add` | `{ userId, role }` | side-effect | `addMember` |
| `membership change-role` | `{ userId, role }` | idempotent | `changeRole` |
| `membership remove` | `{ userId }` | side-effect | `removeMember` |

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
- **The table lists them** when identity is composed: `<generated>/commands.ts` imports `WORKSPACE_COMMANDS` from the
  identity entry and adds `...allOnApis(WORKSPACE_COMMANDS, (app: App) => app.module('workspaces'))` after the
  generated entries. The list is constant-case, so it can't collide with an entity's generated list
  (`workspaceCommands`, were workspace's commands turned back on).

## Not in this step

- Commands for users: today the app creates users through the generated `user` use cases.
- Routes. Under `http: hono` the routes are views of the commands (the Hono lane's).
- Idempotency keys: no command reads `ctx.idempotencyKey` yet (H-1d).

## The gate

- `src/__tests__/runtime/subsystems/identity/workspace-commands.test.ts`: the five names and effects; create, list,
  add, change and remove through `invokeCommand`; every schema refusal names its field and never reaches the service;
  each service refusal's reason, `instead` and body; a crash throws; the limits match the shipped YAML. The fake
  service is shared with the ID-1 tests (`fake-workspaces.ts`).
- `src/__tests__/cli/identity-pattern-stack.test.ts`: the commands table imports `WORKSPACE_COMMANDS` and lists it on
  the `workspaces` module.
- The smoke's Postgres leg (`crud-check.ts`, `workspaceCommandsCheck`): each command through `commandNamed` and
  `invokeCommand`, inside the requester the port resolved from the request's headers, with a refusal each (a taken
  slug, nobody signed in, a second add, a member adding, demoting the last owner, a role that isn't one, a second
  remove), and a removed member refused at once. With the table's line removed from the composition, it fails.
