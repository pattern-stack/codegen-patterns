/**
 * WithAnalytics mixin
 *
 * No-op mixin for v0.1. Will add analytics event emission in a future version.
 * Usage: class MyService extends WithAnalytics(BaseService<...>) { ... }
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = {}> = new (...args: any[]) => T;

export function WithAnalytics<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    // No-op — analytics hooks will be wired here in a future version.
  };
}
