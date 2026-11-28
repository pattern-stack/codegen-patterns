/**
 * The workspace operations as commands (ID-1b): the same five things `WorkspaceService` does, as every way in calls them
 * (HTTP, MCP tools, a CLI). Hand-written, because `workspace` and `membership` have no generated commands
 * (`generate.commands: false`): a generic `workspace list` would read every tenant's workspaces.
 *
 * Each runs on the `workspaces` module (`{ service }`) and reads the requester from the request state, as the service
 * does: a way in runs `invokeCommand` inside `withRequester(…)`. What the service throws for a caller's mistake is a
 * refusal by `attempt`'s one table: nobody signed in is `unauthenticated`, a role that may not is `forbidden`, the last
 * owner or a second add is `conflict`, a user or member that isn't there is `not-found`, a taken slug `unique-violation`.
 * `<generated>/commands.ts` lists them with the generated ones, built for the project: its workspace source (where a
 * membership change is routed) and its `workspace.yaml`'s limits (what `workspace create` accepts).
 */
import { z } from 'zod';
import { defineCommand, type Command } from '@pattern-stack/wiring/commands';
import { attempt, NEST_SUCCESS_STATUS, type CommandHttp } from '../../commands';
import { ROLES, WORKSPACE_ROUTES, type WorkspaceCommandName, type WorkspaceFieldLimits } from './names';
import type { WorkspaceService } from './workspace-service';
import type { WorkspaceSource } from './workspace-sources';

/** What the workspace commands run on: the `workspaces` module. */
export interface WorkspaceCommandApis {
  readonly service: WorkspaceService;
}

/** What the project decides about them: its workspace source, and its `workspace.yaml`'s field limits. */
export interface WorkspaceCommandsOptions {
  readonly source: Pick<WorkspaceSource, 'routePrefix'>;
  readonly limits: WorkspaceFieldLimits;
}

const role = z.enum(ROLES);

/**
 * Every workspace command, each exact, with its HTTP binding (`http`, the shape a derived command carries): its route
 * from `WORKSPACE_ROUTES`, under the source's `routePrefix` when it acts in a workspace (where the requester port reads
 * the workspace from), and its status from `NEST_SUCCESS_STATUS`.
 */
export function workspaceCommandsFor({ source, limits }: WorkspaceCommandsOptions) {
  const prefixes = { root: '', workspace: source.routePrefix } as const;
  /** A command, named by its `WORKSPACE_ROUTES` row (so one without a route fails `tsc`), with its HTTP binding. */
  const route = <I, T>(name: WorkspaceCommandName, spec: Omit<Command<WorkspaceCommandApis, I, T>, 'name'>) => {
    const at = WORKSPACE_ROUTES[name];
    const http: CommandHttp = {
      verb: at.verb,
      path: `${prefixes[at.under]}${at.path}`,
      binding: { path: [...at.pathFields], query: [], body: at.body },
      success: NEST_SUCCESS_STATUS[at.verb],
    };
    return { ...defineCommand<WorkspaceCommandApis, I, T>({ name, ...spec }), http };
  };
  return [
    route('workspace create', {
      summary: 'Create a workspace; you become its owner',
      effect: 'side-effect',
      args: ['name', 'slug'],
      input: z.object({ name: z.string().min(1).max(limits.name), slug: z.string().min(1).max(limits.slug) }),
      run: (apis: WorkspaceCommandApis, input) => attempt(() => apis.service.createWorkspace(input)),
    }),
    route('workspace list-mine', {
      summary: 'List the workspaces you belong to, with your role in each',
      effect: 'read',
      input: z.object({}),
      run: (apis: WorkspaceCommandApis) => attempt(() => apis.service.listMine()),
    }),
    route('membership add', {
      summary: 'Add an existing user to this workspace, with a role',
      effect: 'side-effect',
      args: ['userId', 'role'],
      input: z.object({ userId: z.guid(), role }),
      run: (apis: WorkspaceCommandApis, input) => attempt(() => apis.service.addMember(input)),
    }),
    route('membership change-role', {
      summary: "Change a member's role in this workspace",
      effect: 'idempotent',
      args: ['userId', 'role'],
      input: z.object({ userId: z.guid(), role }),
      run: (apis: WorkspaceCommandApis, input) => attempt(() => apis.service.changeRole(input)),
    }),
    route('membership remove', {
      summary: 'Remove a member from this workspace (yourself, to leave)',
      effect: 'side-effect',
      args: ['userId'],
      input: z.object({ userId: z.guid() }),
      run: (apis: WorkspaceCommandApis, input) => attempt(() => apis.service.removeMember(input)),
    }),
  ] as const;
}
