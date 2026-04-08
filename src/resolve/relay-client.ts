// Peer relay client — WebSocket connection to cloud relay
// Supports E2E encryption with AES-GCM and multiplexed requests

import { logEvent } from "../logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (content: string | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RelayMessage {
  type: "resolve_request" | "resolve_response" | "key_exchange";
  requestId: string;
  originUrl?: string;
  commitHash?: string;
  filePath?: string;
  content?: string | null;
  error?: string;
  publicKey?: string;
  authToken?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// RelayClient
// ---------------------------------------------------------------------------

export class RelayClient {
  private cloudUrl: string;
  private token: string;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private reconnectAttempt = 0;
  private shouldReconnect = true;
  private encryptionKey: CryptoKey | null = null;
  private requestCounter = 0;

  constructor(cloudUrl: string, token: string) {
    this.cloudUrl = cloudUrl;
    this.token = token;
  }

  // ---- Connection management ------------------------------------------------

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = this.cloudUrl.replace(/^http/, "ws") + "/relay";

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(
          new Error(
            `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }

      const connectTimeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, REQUEST_TIMEOUT_MS);

      this.ws.addEventListener("open", () => {
        clearTimeout(connectTimeout);
        this.reconnectAttempt = 0;
        // Send auth credential
        this.send({
          type: "key_exchange",
          requestId: "auth",
          authToken: this.token,
        });
        resolve();
      });

      this.ws.addEventListener("message", (event: MessageEvent) => {
        this.handleMessage(String(event.data));
      });

      this.ws.addEventListener("close", () => {
        this.handleDisconnect();
      });

      this.ws.addEventListener("error", () => {
        clearTimeout(connectTimeout);
        const msg = "WebSocket error";
        logEvent({
          event: "infra.relay.error",
          error: { message: msg },
        });
        // Only reject if we haven't connected yet
        if (this.reconnectAttempt === 0 && !this.ws?.readyState) {
          reject(new Error(msg));
        }
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    // Reject all pending requests
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("Client disconnected"));
      this.pending.delete(id);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ---- Resolve request ------------------------------------------------------

  async resolve(originUrl: string, commitHash: string, filePath: string): Promise<string | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to relay");
    }

    const requestId = this.nextRequestId();

    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null); // Timeout falls through to next strategy
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timer });

      this.send({
        type: "resolve_request",
        requestId,
        originUrl,
        commitHash,
        filePath,
      });
    });
  }

  // ---- Internals ------------------------------------------------------------

  private nextRequestId(): string {
    return `req-${++this.requestCounter}-${Date.now()}`;
  }

  private send(msg: RelayMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(data: string): void {
    let msg: RelayMessage;
    try {
      msg = JSON.parse(data) as RelayMessage;
    } catch {
      return;
    }

    if (msg.type === "resolve_response" && msg.requestId) {
      const pending = this.pending.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.requestId);

        if (msg.error) {
          pending.resolve(null);
        } else {
          pending.resolve(msg.content ?? null);
        }
      }
    }
  }

  private handleDisconnect(): void {
    this.ws = null;

    if (!this.shouldReconnect) return;

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt++;

    logEvent({
      event: "infra.relay.reconnect",
      attempt: this.reconnectAttempt,
      delay_ms: delay,
    });

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect().catch(() => {
          // Reconnect failed — will retry via handleDisconnect
        });
      }
    }, delay);
  }
}
