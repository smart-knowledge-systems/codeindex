import { randomBytes } from "crypto";
import path from "path";
import { unlink } from "fs/promises";
import { mkdirSync } from "fs";
import { CloudClient } from "./client";
import { CloudAuthError } from "./errors";
import { formatError } from "../errors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOUD_URL = process.env.CIDX_CLOUD_URL ?? "http://localhost:8787";
const LOGIN_CALLBACK_HTML = `<html><body><h2>Login successful!</h2><p>You can close this tab.</p><script>window.close()</script></body></html>`;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function cloudLogin(): Promise<void> {
  const client = new CloudClient(CLOUD_URL);

  // Start ephemeral server to receive OAuth callback
  const {
    promise: tokenPromise,
    resolve: resolveToken,
    reject: rejectToken,
  } = Promise.withResolvers<string>();

  const state = randomBytes(32).toString("hex");

  const callbackServer = Bun.serve({
    port: 0, // ephemeral port
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const sessionToken = url.searchParams.get("session_token");
      const returnedState = url.searchParams.get("state");

      if (returnedState !== state) {
        return new Response("Invalid state parameter — possible CSRF attack", { status: 403 });
      }

      if (sessionToken) {
        resolveToken(sessionToken);
        return new Response(LOGIN_CALLBACK_HTML, {
          headers: { "Content-Type": "text/html" },
        });
      }

      return new Response("Missing session_token", { status: 400 });
    },
  });

  const callbackUrl = `http://localhost:${callbackServer.port}/callback`;
  const loginUrl = `${CLOUD_URL}/auth/login?redirect_uri=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;

  // Open browser
  try {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    Bun.spawn([cmd, loginUrl], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // Browser open failed — user can use the printed URL
  }

  process.stderr.write(
    `\nOpen this URL to sign in:\n  ${loginUrl}\n\nWaiting for authentication...\n`,
  );

  // Wait for callback (with a timeout)
  const timeout = setTimeout(
    () => {
      callbackServer.stop();
      rejectToken(new CloudAuthError("Login timed out — no callback received within 5 minutes"));
    },
    5 * 60 * 1000,
  );

  let sessionToken: string;
  try {
    sessionToken = await tokenPromise;
  } finally {
    clearTimeout(timeout);
    callbackServer.stop();
  }

  // Exchange session token for daemon token
  const { token, user } = await client.authExchange(sessionToken);

  // Write credentials
  const credPath = CloudClient.getCredentialsPath();
  const credDir = path.dirname(credPath);
  mkdirSync(credDir, { recursive: true });
  await Bun.write(credPath, JSON.stringify({ token }, null, 2) + "\n", { mode: 0o600 });

  // Verify by fetching status
  client.setToken(token);
  try {
    await client.getStatus();
  } catch (err) {
    process.stderr.write(`Warning: login succeeded but status check failed: ${formatError(err)}\n`);
  }

  process.stderr.write(`\nLogged in as ${user.name} (${user.email})\n`);
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export async function cloudLogout(): Promise<void> {
  const client = new CloudClient(CLOUD_URL);
  await client.loadCredentials();

  if (!client.isAuthenticated()) {
    process.stderr.write("Not logged in.\n");
    return;
  }

  // Revoke token on server (best-effort)
  try {
    await client.authRevoke();
  } catch {
    // Server may be unreachable — still delete local credentials
  }

  // Delete credentials file
  try {
    await unlink(CloudClient.getCredentialsPath());
  } catch {
    // Already deleted or never existed
  }

  process.stderr.write("Logged out.\n");
}
