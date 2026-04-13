/**
 * WithAnalytics — mixin stub for scaffold validation.
 *
 * The generated service uses WithAnalytics(BaseService<...>) mixin pattern.
 * This stub is a no-op pass-through that satisfies the import.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = object> = new (...args: any[]) => T;

/**
 * No-op analytics mixin. In production this would add analytics tracking.
 * For the scaffold it just passes the base class through unchanged.
 */
export function WithAnalytics<TBase extends Constructor>(Base: TBase): TBase {
  return Base;
}
