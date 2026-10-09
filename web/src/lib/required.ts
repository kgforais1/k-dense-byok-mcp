/** Fail visibly when a required runtime value is absent. */
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required value is missing");
  return value;
}
