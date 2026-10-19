/** Orders strings by code point, which does not depend on the locale (UTF-8 byte order is code point order). */
export function compareCodePoints(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
