/**
 * `codegen init` shortcut — aliases `codegen project init`.
 *
 * Kept as a thin subclass so help output still shows the canonical form
 * while users can type the shorter name.
 */

import { ProjectInitCommand } from '../commands/project.js';

export class InitShortcut extends ProjectInitCommand {
	static paths = [['init']];
	static usage = ProjectInitCommand.usage;
}

export default InitShortcut;
