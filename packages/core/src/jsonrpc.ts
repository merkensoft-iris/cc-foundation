/**
 * JSON-RPC 2.0, one JSON object per line (04 §4.1 rule 2). Errors carry the CC error data
 * of 04 §4.1 rule 4 in `error.data`.
 */
import type { ApiErrorData } from '@cc/schemas';

import { CoreError } from './errors.js';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
  /** Absent for a notification, which gets no response. */
  readonly id?: JsonRpcId;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data: ApiErrorData;
}

export type JsonRpcResponse =
  | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly error: JsonRpcErrorObject };

/** The JSON-RPC 2.0 error codes, and -32000 for every other CC error. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
export const RPC_APPLICATION_ERROR = -32000;

/** Largest request line the server reads; a longer one closes the connection. */
export const MAX_LINE_BYTES = 1024 * 1024;

const REQUEST_MEMBERS = new Set(['jsonrpc', 'method', 'params', 'id']);

/** A request that cannot be served, with the id to answer it under. */
export class BadRequest extends Error {
  readonly id: JsonRpcId;
  readonly rpcCode: number;

  constructor(id: JsonRpcId, rpcCode: number, message: string) {
    super(message);
    this.id = id;
    this.rpcCode = rpcCode;
  }
}

function isId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || Number.isInteger(value);
}

/**
 * Parses one line into a request. Extra members are refused, so a caller cannot smuggle an
 * actor or a principal next to its params (04 §4.3 rule 1).
 */
export function parseRequest(line: string): JsonRpcRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new BadRequest(null, RPC_PARSE_ERROR, 'parse error: each line must be one JSON object');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequest(null, RPC_INVALID_REQUEST, 'invalid request: expected one JSON object');
  }
  const request = value as Record<string, unknown>;
  const id = isId(request['id']) ? request['id'] : null;
  for (const key of Object.keys(request)) {
    if (!REQUEST_MEMBERS.has(key)) {
      throw new BadRequest(id, RPC_INVALID_REQUEST, `invalid request: unexpected member "${key}"`);
    }
  }
  if (request['jsonrpc'] !== '2.0') {
    throw new BadRequest(id, RPC_INVALID_REQUEST, 'invalid request: jsonrpc must be "2.0"');
  }
  if (typeof request['method'] !== 'string' || request['method'].length === 0) {
    throw new BadRequest(id, RPC_INVALID_REQUEST, 'invalid request: method must be a string');
  }
  if ('id' in request && !isId(request['id'])) {
    throw new BadRequest(
      null,
      RPC_INVALID_REQUEST,
      'invalid request: id must be a string or integer',
    );
  }
  const params = request['params'];
  if (
    params !== undefined &&
    (typeof params !== 'object' || params === null || Array.isArray(params))
  ) {
    throw new BadRequest(id, RPC_INVALID_PARAMS, 'invalid params: params must be an object');
  }
  return {
    jsonrpc: '2.0',
    method: request['method'],
    ...(params === undefined ? {} : { params }),
    ...('id' in request ? { id: request['id'] as JsonRpcId } : {}),
  };
}

function rpcCodeFor(error: CoreError, method?: string): number {
  if (error.code === 'E_INTERNAL') return RPC_INTERNAL_ERROR;
  if (error.code === 'E_USAGE') {
    if (error.message.startsWith('unknown method')) return RPC_METHOD_NOT_FOUND;
    if (method !== undefined && error.message.startsWith(`invalid params for ${method}`)) {
      return RPC_INVALID_PARAMS;
    }
  }
  return RPC_APPLICATION_ERROR;
}

export function errorResponse(id: JsonRpcId, error: CoreError, method?: string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: rpcCodeFor(error, method), message: error.message, data: error.toData() },
  };
}

export function badRequestResponse(error: BadRequest): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: error.id,
    error: {
      code: error.rpcCode,
      message: error.message,
      data: {
        code: 'E_USAGE',
        message: error.message,
        help: ['Send JSON-RPC 2.0, one object per line'],
      },
    },
  };
}

export function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** The CC error a client should raise for a JSON-RPC error object. */
export function errorFromResponse(error: unknown): CoreError {
  const data = (error as { data?: Partial<ApiErrorData> } | undefined)?.data;
  if (data !== undefined && typeof data.code === 'string' && typeof data.message === 'string') {
    return new CoreError(data.code, data.message, Array.isArray(data.help) ? data.help : []);
  }
  const message = (error as { message?: unknown } | undefined)?.message;
  return new CoreError('E_INTERNAL', typeof message === 'string' ? message : 'unknown error');
}

/**
 * Splits a byte stream into lines. Returns complete lines; keeps the rest. Throws when a
 * pending line grows past `maxBytes`.
 */
export class LineSplitter {
  #pending = '';
  readonly #maxBytes: number;

  constructor(maxBytes = MAX_LINE_BYTES) {
    this.#maxBytes = maxBytes;
  }

  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines = this.#pending.split('\n');
    this.#pending = lines.pop() ?? '';
    for (const line of [...lines, this.#pending]) {
      if (Buffer.byteLength(line) > this.#maxBytes) {
        throw new RangeError(`request line over ${this.#maxBytes} bytes`);
      }
    }
    return lines.map((line) => line.replace(/\r$/, '')).filter((line) => line.trim().length > 0);
  }
}
