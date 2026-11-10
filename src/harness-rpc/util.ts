import { RPC_ERROR } from './protocol.ts';
import { RpcRequestError } from './error.ts';

/** Treat absent params as an empty object; reject any non-object shape. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new RpcRequestError(RPC_ERROR.invalidRequest, 'Request params must be a JSON object.');
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcRequestError(RPC_ERROR.invalidRequest, `The "${field}" parameter must be a non-empty string.`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === 'string')) {
    throw new RpcRequestError(RPC_ERROR.invalidRequest, `The "${field}" parameter must be a non-empty array of strings.`);
  }
  return value as string[];
}

export function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new RpcRequestError(RPC_ERROR.invalidRequest, 'Expected an array of strings.');
  }
  return value as string[];
}
