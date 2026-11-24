import { randomBytes } from "node:crypto";
import { APP_BROWSER_SESSION_SECONDS } from "@cohub/protocol";
import { redisCommandClient } from "../redis.js";

const epochKey = (userUuid: string) => `app:browser-epoch:${userUuid}`;

/** Storefront sign-ins are valid only while the account's epoch is unchanged. */
export async function currentAppBrowserEpoch(userUuid: string) {
  return await redisCommandClient.get(epochKey(userUuid)) ?? "";
}

/** The epoch must outlive every session and token that references it. */
export async function retainAppBrowserEpoch(userUuid: string) {
  await redisCommandClient.expire(epochKey(userUuid), APP_BROWSER_SESSION_SECONDS);
}

/** Ends every storefront session and token of this account, on every device. */
export async function revokeAppBrowserSessions(userUuid: string) {
  await redisCommandClient.set(epochKey(userUuid), randomBytes(32).toString("base64url"), "EX", APP_BROWSER_SESSION_SECONDS);
}

/** Tokens minted from a storefront sign-in stop working once it is revoked. */
export async function isAppBrowserTokenLive(token: { userUuid: string; browserEpoch?: string }) {
  return token.browserEpoch === undefined || token.browserEpoch === await currentAppBrowserEpoch(token.userUuid);
}
