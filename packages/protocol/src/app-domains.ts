/** One-time charge for each custom domain binding, in USD. */
export const APP_DOMAIN_PRICE_USD = 5;
/** CNAME target users point their hostname to, unless deployment overrides it. */
export const APP_DOMAIN_DEFAULT_CNAME_TARGET = "cname.cohub.live";
export const APP_DOMAIN_CHALLENGE_LABEL = "_cohub-challenge";
export const APP_DOMAIN_TOKEN_PREFIX = "cohub-verify=";

export const APP_DOMAIN_CHECK_JOB = "app_domain.check";
export const APP_DOMAIN_SWEEP_JOB = "app_domain.sweep";
export type AppDomainCheckJobData = {
	domainId: string;
	/** Set on one-off jobs for a change made while the regular job was running (Redis-clock ms). */
	requestedAt?: number;
};

export const APP_DOMAIN_STATUSES = [
	"pending",
	"provisioning",
	"active",
	"failed",
	"removing",
] as const;
export type AppDomainStatus = (typeof APP_DOMAIN_STATUSES)[number];

/** Statuses that own the hostname and its Cloudflare custom hostname. */
export const APP_DOMAIN_EXCLUSIVE_STATUSES = [
	"provisioning",
	"active",
	"removing",
] as const satisfies readonly AppDomainStatus[];

export type AppDomainErrorCode =
	| "domain_invalid"
	| "domain_reserved"
	| "domain_in_use"
	| "app_domain_exists"
	| "app_not_eligible"
	| "ownership_not_found"
	| "verification_expired"
	| "insufficient_balance"
	| "dns_moved"
	| "certificate_failed"
	| "provider_unavailable";

export type AppDomainDnsRecord = {
	type: "CNAME" | "TXT";
	name: string;
	value: string;
	purpose: "routing" | "ownership";
	satisfied: boolean | null;
};

export type AppDomainRecord = {
	id: string;
	appId: string;
	spaceId: string;
	hostname: string;
	url: string;
	status: AppDomainStatus;
	dnsRecords: AppDomainDnsRecord[];
	certificateStatus: string | null;
	error: { code: AppDomainErrorCode; message: string } | null;
	verifiedAt: string | null;
	activatedAt: string | null;
	lastCheckedAt: string | null;
	createdAt: string;
	/** Orders snapshots: a client keeps the newer of two records for one id. */
	updatedAt: string;
	priceUsd: number;
	charged: boolean;
};

export type AppDomainListResponse = {
	domains: AppDomainRecord[];
	enabled: boolean;
	/** Whether the App can be served on a custom domain right now. */
	eligible: boolean;
	priceUsd: number;
	cnameTarget: string | null;
};

export type AppDomainRemovedReason = "removed" | "transferred";

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Normalizes user input into a lowercase ASCII (punycode) hostname, or null
 * when it is not a plain multi-label hostname (no scheme, port, path, wildcard
 * or IP literal).
 */
export function normalizeAppDomainHostname(input: string): string | null {
	const raw = input.trim().toLowerCase().replace(/\.$/, "");
	if (!raw || /[\s/:@*?#\\]/.test(raw)) return null;
	let hostname: string;
	try {
		hostname = new URL(`https://${raw}`).hostname;
	} catch {
		return null;
	}
	if (hostname.length > 253 || IPV4_RE.test(hostname)) return null;
	const labels = hostname.split(".");
	if (labels.length < 2) return null;
	if (!labels.every((label) => LABEL_RE.test(label))) return null;
	if (/^\d+$/.test(labels.at(-1) ?? "")) return null;
	return hostname;
}

export function isHostnameWithin(hostname: string, suffix: string): boolean {
	const zone = suffix.trim().toLowerCase().replace(/^\.+/, "");
	return Boolean(zone) && (hostname === zone || hostname.endsWith(`.${zone}`));
}

export function appDomainChallengeName(hostname: string): string {
	return `${APP_DOMAIN_CHALLENGE_LABEL}.${hostname}`;
}

export function appDomainChallengeValue(token: string): string {
	return `${APP_DOMAIN_TOKEN_PREFIX}${token}`;
}
