import { randomBytes } from "node:crypto";
import { APP_BROWSER_SESSION_SECONDS } from "@cohub/protocol";
import { redisCommandClient } from "../redis.js";

const epochKey = (userUuid: string) => `app:browser-epoch:${userUuid}`;

/** App sign-ins and tokens are valid only while the account's epoch is unchanged. */
export async function currentAppBrowserEpoch(userUuid: string) {
  return await redisCommandClient.get(epochKey(userUuid)) ?? "";
}

/** Reads the epoch for a new sign-in or token and keeps it alive as long as they may reference it. */
export async function holdAppBrowserEpoch(userUuid: string) {
  const epoch = await currentAppBrowserEpoch(userUuid);
  if (epoch) await redisCommandClient.expire(epochKey(userUuid), APP_BROWSER_SESSION_SECONDS);
  return epoch;
}

/** Ends every App sign-in and App token of this account, on every device. */
export async function revokeAppBrowserSessions(userUuid: string) {
  await redisCommandClient.set(epochKey(userUuid), randomBytes(32).toString("base64url"), "EX", APP_BROWSER_SESSION_SECONDS);
}

/** Tokens minted for an account stop working once its App sign-ins are revoked. */
export async function isAppBrowserTokenLive(token: { userUuid: string; browserEpoch?: string }) {
  return token.browserEpoch === undefined || token.browserEpoch === await currentAppBrowserEpoch(token.userUuid);
}
