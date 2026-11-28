/**
 * Orders strings by UTF-16 code unit, as `<` does and as the durable stores' binary collation does: never by locale,
 * so an id or a name sorts the same on every store and every machine.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
