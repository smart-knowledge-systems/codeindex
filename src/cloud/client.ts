import path from "path";
import os from "os";
import { logEvent } from "../logging";
import { CloudAuthError, CloudNetworkError, CloudRateLimitError, CloudServerError } from "./errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CloudUser {
  id: string;
  email: string;
  name: string;
  plan: string;
}

export interface IngestBeginParams {
  repo?: string;
  hashes?: string[];
}

export interface IngestBeginResult {
  jobId: string;
  known_hashes: string[];
}

export interface IngestBatchParams {
  jobId: string;
  files: { contentHash: string; path: string; language: string; sizeBytes: number }[];
}

export interface IngestBatchResult {
  embedded: number;
  skipped: number;
}

export interface IngestCompleteParams {
  jobId: string;
}

export interface IngestCompleteResult {
  cost_usd: number;
  files_indexed: number;
}

export interface SearchParams {
  query: string;
  limit?: number;
}

export interface SearchResult {
  path: string;
  language: string;
  contentHash: string;
  score: number;
}

export interface StatusResult {
  user: CloudUser;
  repos: number;
  files_indexed: number;
  usage: { embeddings: number; storage_mb: number };
}

export interface MigrateParams {
  files: { contentHash: string; path: string; language: string; sizeBytes: number }[];
}

export interface MigrateResult {
  imported: number;
  skipped: number;
  total: number;
}

interface Credentials {
  token: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const CREDENTIALS_PATH = path.join(os.homedir(), ".config", "cidx", "credentials.json");

// ---------------------------------------------------------------------------
// CloudClient
// ---------------------------------------------------------------------------

export class CloudClient {
  readonly baseUrl: string;
  private token: string | undefined;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.CIDX_CLOUD_URL ?? "http://localhost:8787";
  }

  // ---- Credential management ------------------------------------------------

  async loadCredentials(): Promise<void> {
    try {
      const file = Bun.file(CREDENTIALS_PATH);
      if (await file.exists()) {
        const creds = (await file.json()) as Credentials;
        this.token = creds.token;
      }
    } catch {
      // Credentials missing or invalid — leave token undefined
    }
  }

  setToken(token: string): void {
    this.token = token;
  }

  isAuthenticated(): boolean {
    return this.token !== undefined && this.token.length > 0;
  }

  getToken(): string | undefined {
    return this.token;
  }

  static getCredentialsPath(): string {
    return CREDENTIALS_PATH;
  }

  // ---- Core request ---------------------------------------------------------

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.requestWithRetry<T>(method, path, body, 0);
  }

  private async requestWithRetry<T>(
    method: string,
    reqPath: string,
    body: unknown | undefined,
    attempt: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${reqPath}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network error — retry with backoff
      if (attempt < MAX_RETRIES && err instanceof TypeError) {
        const delay = 1000 * Math.pow(2, attempt);
        logEvent({
          event: "infra.cloud.retry",
          attempt: attempt + 1,
          delay_ms: delay,
          "error.type": "network",
          "error.message": err instanceof Error ? err.message : String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.requestWithRetry<T>(method, reqPath, body, attempt + 1);
      }
      throw new CloudNetworkError(err instanceof Error ? err.message : "Unable to reach cloud API");
    }

    // 401 — auth error, no retry
    if (response.status === 401) {
      throw new CloudAuthError();
    }

    // 429 — rate limited, retry with backoff
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After")) || undefined;
      if (attempt < MAX_RETRIES) {
        const delay = (retryAfter ?? 1) * 1000 * Math.pow(2, attempt);
        logEvent({
          event: "infra.cloud.retry",
          attempt: attempt + 1,
          delay_ms: delay,
          "error.type": "rate_limit",
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.requestWithRetry<T>(method, reqPath, body, attempt + 1);
      }
      throw new CloudRateLimitError(undefined, retryAfter);
    }

    // 5xx — server error, retry with backoff
    if (response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        logEvent({
          event: "infra.cloud.retry",
          attempt: attempt + 1,
          delay_ms: delay,
          "error.type": "server",
          statusCode: response.status,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.requestWithRetry<T>(method, reqPath, body, attempt + 1);
      }
      throw new CloudServerError(`Cloud server error (${response.status})`, response.status);
    }

    // Other non-OK
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new CloudServerError(
        `Cloud API error: ${response.status} ${text}`.trim(),
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  // ---- Typed endpoint methods -----------------------------------------------

  async ingestBegin(params: IngestBeginParams): Promise<IngestBeginResult> {
    return this.request<IngestBeginResult>("POST", "/ingest/begin", params);
  }

  async ingestBatch(params: IngestBatchParams): Promise<IngestBatchResult> {
    return this.request<IngestBatchResult>("POST", "/ingest/batch", params);
  }

  async ingestComplete(params: IngestCompleteParams): Promise<IngestCompleteResult> {
    return this.request<IngestCompleteResult>("POST", "/ingest/complete", params);
  }

  async search(params: SearchParams): Promise<SearchResult[]> {
    return this.request<SearchResult[]>("POST", "/search", params);
  }

  async getStatus(): Promise<StatusResult> {
    return this.request<StatusResult>("GET", "/status");
  }

  async migrate(params: MigrateParams): Promise<MigrateResult> {
    return this.request<MigrateResult>("POST", "/migrate", params);
  }

  async authExchange(sessionToken: string): Promise<{ token: string; user: CloudUser }> {
    return this.request<{ token: string; user: CloudUser }>("POST", "/auth/exchange", {
      session_token: sessionToken,
    });
  }

  async authRevoke(): Promise<void> {
    await this.request<{ ok: boolean }>("POST", "/auth/revoke");
  }
}
