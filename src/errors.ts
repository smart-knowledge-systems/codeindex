export type ErrorCode =
  | "ERR_NOT_INDEXED"
  | "ERR_AUTH_REQUIRED"
  | "ERR_AUTH_DENIED"
  | "ERR_SCOPE_VIOLATION"
  | "ERR_RATE_LIMITED"
  | "ERR_COST_CAP_EXCEEDED"
  | "ERR_INVALID_ARGS"
  | "ERR_CLOUD_AUTH"
  | "ERR_CLOUD_RATE_LIMITED"
  | "ERR_CLOUD_SERVER"
  | "ERR_CLOUD_NETWORK"
  | "ERR_CLOUD_OFFLINE";

export class CodeindexError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CodeindexError";
    this.code = code;
  }
}

export function formatError(err: unknown): string {
  if (err instanceof CodeindexError) {
    return `Error [${err.code}]: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
