import { CodeindexError } from "../errors";

export class CloudAuthError extends CodeindexError {
  constructor(message = "Authentication required — run `cidx login` to sign in") {
    super("ERR_CLOUD_AUTH", message);
    this.name = "CloudAuthError";
  }
}

export class CloudRateLimitError extends CodeindexError {
  readonly retryAfter?: number;

  constructor(message = "Rate limited by cloud API — please retry shortly", retryAfter?: number) {
    super("ERR_CLOUD_RATE_LIMITED", message);
    this.name = "CloudRateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class CloudServerError extends CodeindexError {
  readonly statusCode: number;

  constructor(message = "Cloud server error — please try again later", statusCode = 500) {
    super("ERR_CLOUD_SERVER", message);
    this.name = "CloudServerError";
    this.statusCode = statusCode;
  }
}

export class CloudNetworkError extends CodeindexError {
  constructor(message = "Unable to reach cloud API — check your network connection") {
    super("ERR_CLOUD_NETWORK", message);
    this.name = "CloudNetworkError";
  }
}
