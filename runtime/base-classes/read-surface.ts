/**
 * The generated read surface owns its names (READ-1 §3.4).
 *
 * A generated repository defines `findById` / `findByIds` / `list` itself: their
 * typed `columns` / `with` signatures cannot live on the base (REL-2 §2.1,
 * TS2536), and the shaped read cannot be delegated to `super` (a base or mixin
 * override takes neither option, so the result would no longer be the type the
 * signature promises). The generated service forwards the same three names
 * straight to the repository for the same reason.
 *
 * So an override of one of those names on a class BETWEEN the base and the
 * generated class — a pattern base class, a capability mixin — can never run.
 * That must not be silent: the generated constructor calls
 * {@link assertGeneratedReadsOwned}, which throws at construction, naming the
 * method and the class that overrides it. A SUBCLASS of the generated class is
 * not checked — its override runs.
 */

/** The base-class read names a generated repository and service define themselves. */
export const GENERATED_READS = ['findById', 'findByIds', 'list'] as const;

/** Any class, abstract or not. */
type AnyClass = abstract new (...args: any[]) => unknown;

/**
 * Throw when a class between `base` and `owner` (exclusive at both ends) has its
 * own {@link GENERATED_READS} member. `hint` says where that logic belongs.
 */
export function assertGeneratedReadsOwned(owner: AnyClass, base: AnyClass, hint: string): void {
  let proto: object | null = Object.getPrototypeOf(owner.prototype);
  while (proto !== null && proto !== base.prototype) {
    for (const method of GENERATED_READS) {
      if (Object.prototype.hasOwnProperty.call(proto, method)) {
        const by = (proto as { constructor?: { name?: string } }).constructor?.name || 'an anonymous class';
        throw new Error(
          `${owner.name}: ${by}.${method} overrides a read the generated ${owner.name} defines itself, ` +
            `so it would never run (READ-1 §3.4). The generated findById / findByIds / list own those names. ${hint}`,
        );
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
}
