/**
 * WithAnalytics mixin
 *
 * Adds an optional `.analytics` property to the service class.
 * The analytics provider is a per-entity @Injectable (e.g., AccountAnalytics)
 * injected via @Optional() in the generated service constructor.
 *
 * Usage: class MyService extends WithAnalytics(BaseService<...>) { ... }
 *
 * The generated service adds:
 *   @Optional() @Inject(AccountAnalytics) override analytics?: AccountAnalytics
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = {}> = abstract new (...args: any[]) => T;

export function WithAnalytics<TBase extends Constructor>(Base: TBase) {
  abstract class WithAnalyticsMixin extends Base {
    analytics?: any;
  }
  return WithAnalyticsMixin as TBase & typeof WithAnalyticsMixin;
}
