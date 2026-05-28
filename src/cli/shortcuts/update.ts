/**
 * `codegen update` shortcut — aliases `codegen project update`.
 *
 * Kept as a thin subclass so help output still shows the canonical form while
 * users can type the shorter, discoverable name.
 */

import { ProjectUpdateCommand } from '../commands/project-update.js';

export class UpdateShortcut extends ProjectUpdateCommand {
	static paths = [['update']];
	static usage = ProjectUpdateCommand.usage;
}

export default UpdateShortcut;
