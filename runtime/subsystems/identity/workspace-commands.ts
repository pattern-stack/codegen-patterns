/**
 * The workspace operations as commands (ID-1b): the same five things `WorkspaceService` does, as every way in calls them
 * (HTTP, MCP tools, a CLI). Hand-written, because `workspace` and `membership` have no generated commands
 * (`generate.commands: false`): a generic `workspace list` would read every tenant's workspaces.
 *
 * Each runs on the `workspaces` module (`{ service }`) and reads the requester from the request state, as the service
 * does: a way in runs `invokeCommand` inside `withRequester(…)`. What the service throws for a caller's mistake is a
 * refusal by `attempt`'s one table: nobody signed in is `unauthenticated`, a role that may not is `forbidden`, the last
 * owner or a second add is `conflict`, a user or member that isn't there is `not-found`, a taken slug `unique-violation`.
 * `<generated>/commands.ts` lists them with the generated ones.
 */
import { z } from 'zod';
import { defineCommand } from '@pattern-stack/wiring/commands';
import { attempt } from '../../commands';
import { ROLES, WORKSPACE_FIELD_MAX } from './names';
import type { WorkspaceService } from './workspace-service';

/** What the workspace commands run on: the `workspaces` module. */
export interface WorkspaceCommandApis {
  readonly service: WorkspaceService;
}

const role = z.enum(ROLES);

export const workspaceCreateCommand = defineCommand({
  name: 'workspace create',
  summary: 'Create a workspace; you become its owner',
  effect: 'side-effect',
  args: ['name', 'slug'],
  input: z.object({
    name: z.string().min(1).max(WORKSPACE_FIELD_MAX.name),
    slug: z.string().min(1).max(WORKSPACE_FIELD_MAX.slug),
  }),
  run: (apis: WorkspaceCommandApis, input) => attempt(() => apis.service.createWorkspace(input)),
});

export const workspaceListMineCommand = defineCommand({
  name: 'workspace list-mine',
  summary: 'List the workspaces you belong to, with your role in each',
  effect: 'read',
  input: z.object({}),
  run: (apis: WorkspaceCommandApis) => attempt(() => apis.service.listMine()),
});

export const membershipAddCommand = defineCommand({
  name: 'membership add',
  summary: 'Add an existing user to this workspace, with a role',
  effect: 'side-effect',
  args: ['userId', 'role'],
  input: z.object({ userId: z.guid(), role }),
  run: (apis: WorkspaceCommandApis, input) => attempt(() => apis.service.addMember(input)),
});

export const membershipChangeRoleCommand = defineCommand({
  name: 'membership change-role',
  summary: "Change a member's role in this workspace",
  effect: 'idempotent',
  args: ['userId', 'role'],
  input: z.object({ userId: z.guid(), role }),
  run: (apis: WorkspaceCommandApis, input) => attempt(() => apis.service.changeRole(input)),
});

export const membershipRemoveCommand = defineCommand({
  name: 'membership remove',
  summary: 'Remove a member from this workspace (yourself, to leave)',
  effect: 'side-effect',
  args: ['userId'],
  input: z.object({ userId: z.guid() }),
  run: (apis: WorkspaceCommandApis, input) => attempt(() => apis.service.removeMember(input)),
});

/**
 * Every workspace command, each exact; `<generated>/commands.ts` re-targets them onto the composed app. Constant-case,
 * so it can't share a name with an entity's generated list (`workspaceCommands`, were workspace's turned back on).
 */
export const WORKSPACE_COMMANDS = [
  workspaceCreateCommand,
  workspaceListMineCommand,
  membershipAddCommand,
  membershipChangeRoleCommand,
  membershipRemoveCommand,
] as const;
