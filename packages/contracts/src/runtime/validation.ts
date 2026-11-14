// Small boundary validators; no coercion, unknown keys, or input values in errors.
export class ContractError extends Error {
  readonly code = "invalid_contract";
  readonly field: string;
  constructor(field: string) {
    super(`Invalid contract field: ${field}`);
    this.field = field;
  }
}

export function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ContractError(field);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ContractError(field);
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new ContractError(field);
  return value as Record<string, unknown>;
}

export function string(value: unknown, field: string, max = 2000, min = 1): string {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new ContractError(field);
  return value;
}

export function id(value: unknown, field: string): string {
  const result = string(value, field, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(result)) throw new ContractError(field);
  return result;
}

export function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new ContractError(field);
  return value;
}

export function choice<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new ContractError(field);
  return value as T[number];
}

export function list<T>(
  value: unknown,
  parse: (item: unknown) => T,
  field: string,
  max: number,
  min = 0,
): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new ContractError(field);
  return Array.from(value, parse);
}

export function nullableId(value: unknown, field: string): string | null {
  return value === null ? null : id(value, field);
}

export function httpUrl(value: unknown, field: string): string {
  const raw = string(value, field, 4096);
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new ContractError(field);
    return url.href;
  } catch {
    throw new ContractError(field);
  }
}

export function version(value: unknown): 1 {
  if (value !== 1) throw new ContractError("protocolVersion");
  return 1;
}
