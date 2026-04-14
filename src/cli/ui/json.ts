/**
 * JSON mode state + structured output helper.
 *
 * When enabled, the UI helpers (printSuccess, withStatus, renderPane, renderHints)
 * short-circuit so commands can emit pure JSON without visual noise.
 */

let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
	jsonMode = enabled;
}

export function isJsonMode(): boolean {
	return jsonMode;
}

export function printJson(data: unknown): void {
	process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}
