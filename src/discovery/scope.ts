/** A push must be a nonempty string representing a finite timestamp. */
export function isUsablePush(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}
