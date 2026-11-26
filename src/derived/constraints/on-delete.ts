/**
 * The referential action a relationship's `on_delete:` declares (TGT-1, ADR-047) — the entity and junction pipelines'
 * one owner of the YAML → SQL mapping (each used to keep a copy). The relationship pipeline still keeps its own
 * (`ON_DELETE_MAP`), cut with the rest of that pipeline's copy (TGT-0 § Next 2).
 *
 * A fact, not target text: `'set null'` is the SQL standard's spelling of the action, which every SQL database and
 * Drizzle's `pg-core` / `sqlite-core` builders share. The YAML uses snake_case (`set_null`, `no_action`, ADR-021).
 *
 * Hygen-safe: reached from `entity-locals.js` and the junction prompt; imports nothing.
 */

/** A foreign key's referential action, as SQL spells it. */
export type OnDeleteAction = 'restrict' | 'cascade' | 'set null' | 'no action';

const ACTIONS: Readonly<Record<string, OnDeleteAction>> = {
	restrict: 'restrict',
	cascade: 'cascade',
	set_null: 'set null',
	no_action: 'no action',
};

/**
 * The SQL action for a YAML `on_delete:` value. Absent (or a value the YAML schema should already have refused) is
 * `restrict`, the default both pipelines declared.
 */
export function onDeleteAction(onDelete: string | undefined): OnDeleteAction {
	// Own keys only: a value such as `constructor` must not reach the object's prototype.
	return onDelete !== undefined && Object.hasOwn(ACTIONS, onDelete) ? ACTIONS[onDelete]! : 'restrict';
}
