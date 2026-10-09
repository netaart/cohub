import type { Command } from "commander";
import { authSource, loginWithDeviceFlow, readAuthSession, refreshAccessToken, requestDeviceCode, revokeAndClearAuthSession, verifyDeviceCode } from "../auth.js";
import { clearHomeSpaceCache } from "../space.js";
import { createClient } from "../client.js";
import { table, json as outJson, jsonRequested, ok, error, spinner, handleHttp } from "../output.js";

type LoginOptions = {
  requestCode?: boolean;
  verifyCode?: boolean;
  json?: boolean;
};

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Authentication management");

  auth
    .command("login")
    .description("Sign in with Logto device authorization")
    .option("--request-code", "Request a device code without polling")
    .option("--verify-code", "Exchange a previously requested device code")
    .option("--json", "Output as JSON")
    .action(async (opts: LoginOptions) => {
      const asJson = jsonRequested(opts);
      if (opts.requestCode && opts.verifyCode) {
        return error("Conflicting options", "Use only one of --request-code or --verify-code");
      }

      try {
        if (opts.requestCode) {
          const code = await requestDeviceCode();
          if (asJson) return outJson(code);
          printDeviceCode(code);
          return;
        }

        if (opts.verifyCode) {
          await verifyDeviceCode();
          return showSignedIn(asJson);
        }

        const sp = spinner();
        sp.start("Starting login");
        await loginWithDeviceFlow((code) => {
          sp.stop("Login started");
          printDeviceCode(code);
          process.stderr.write("  Waiting for authorization...\n");
        });
        return showSignedIn(asJson);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  auth
    .command("whoami")
    .description("Show current user info")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const asJson = jsonRequested(opts);
      return showSignedIn(asJson);
    });

  auth
    .command("refresh")
    .description("Refresh the stored Logto access token")
    .action(async () => {
      try {
        if (authSource() === "execution-token") {
          return error("Cannot refresh COHUB_EXECUTION_TOKEN", "Run `cohub auth login` for long-lived Logto auth.");
        }
        await refreshAccessToken();
        ok("Token refreshed");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  auth
    .command("logout")
    .description("Clear stored Logto session")
    .action(async () => {
      await revokeAndClearAuthSession();
      clearHomeSpaceCache();
      if (process.env.COHUB_EXECUTION_TOKEN?.trim()) {
        ok("Local session cleared. COHUB_EXECUTION_TOKEN is still set.");
      } else {
        ok("Signed out");
      }
    });
}

async function showSignedIn(asJson?: boolean): Promise<void> {
  const source = authSource();
  if (!source) return error("Not authenticated", "Run `cohub auth login`.");

  const client = createClient();
  const sp = asJson ? null : spinner();
  sp?.start("Fetching user info");

  try {
    const user = await client.user.getMe();
    sp?.stop("Done");
    const session = readAuthSession();
    const payload = {
      source,
      refreshable: source === "logto" && Boolean(session?.refreshToken),
      user,
    };
    if (asJson) return outJson(payload);
    const u = flattenMeForTable(user as Record<string, unknown>);
    console.log(`  Auth source: ${source}`);
    console.log(`  Token: ${payload.refreshable ? "refreshable" : "ephemeral"}\n`);
    table([u], [
      { key: "uuid", label: "UUID" },
      { key: "username", label: "Username" },
      { key: "displayName", label: "Name" },
      { key: "email", label: "Email" },
    ]);
  } catch (e: unknown) {
    if (source === "execution-token") {
      sp?.stop("Using local execution token");
      return showExecutionTokenFallback(asJson);
    }
    sp?.stop("Failed");
    handleHttp(e);
  }
}

function flattenMeForTable(user: Record<string, unknown>): Record<string, unknown> {
  const profile = user.profile && typeof user.profile === "object" ? user.profile as Record<string, unknown> : {};
  return {
    uuid: user.uuid,
    username: profile.username,
    displayName: profile.displayName,
    email: user.email,
  };
}

function decodeExecutionTokenPayload(): Record<string, unknown> | null {
  const token = process.env.COHUB_EXECUTION_TOKEN?.trim();
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf-8");
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function showExecutionTokenFallback(asJson?: boolean): void {
  const payload = decodeExecutionTokenPayload();
  const execution = {
    actorUserId: typeof payload?.actorUserId === "string" ? payload.actorUserId : null,
    spaceId: typeof payload?.spaceId === "string" ? payload.spaceId : null,
    sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : null,
    source: typeof payload?.source === "string" ? payload.source : null,
    expiresAt: typeof payload?.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null,
  };
  const result = {
    source: "execution-token" as const,
    refreshable: false,
    user: execution.actorUserId ? { uuid: execution.actorUserId } : null,
    execution,
  };
  if (asJson) {
    outJson(result);
    return;
  }

  console.log("  Auth source: execution-token");
  console.log("  Token: ephemeral\n");
  table([execution], [
    { key: "actorUserId", label: "Actor" },
    { key: "spaceId", label: "Space" },
    { key: "sessionId", label: "Session" },
    { key: "source", label: "Source" },
    { key: "expiresAt", label: "Expires" },
  ]);
}

function printDeviceCode(code: { userCode: string; verificationUriComplete: string; expiresAt: number }): void {
  console.log("\nOpen this URL to sign in:\n");
  console.log(`  ${code.verificationUriComplete}\n`);
  console.log("Or enter this code manually:\n");
  console.log(`  ${code.userCode}\n`);
  console.log(`Code expires at ${new Date(code.expiresAt).toLocaleString()}.`);
}
