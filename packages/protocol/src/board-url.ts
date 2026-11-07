import * as z from "zod";

export const BOARD_REMOTE_URL_MAX_LENGTH = 4096;

function parseIpv4(host: string): [number, number, number, number] | null {
	const parts = host.split(".").map(Number);
	return parts.length === 4 &&
		parts.every(
			(part) => Number.isInteger(part) && part >= 0 && part <= 255,
		)
		? (parts as [number, number, number, number])
		: null;
}

function isBlockedIpv4(host: string): boolean {
	const parts = parseIpv4(host);
	if (!parts) return false;
	const [first, second, third] = parts;
	if (first === 0 || first === 10 || first === 127) return true;
	if (first === 100 && second >= 64 && second <= 127) return true;
	if (first === 169 && second === 254) return true;
	if (first === 172 && second >= 16 && second <= 31) return true;
	if (first === 192 && second === 168) return true;
	if (first === 192 && second === 0 && (third === 0 || third === 2)) return true;
	if (first === 192 && second === 88 && third === 99) return true;
	if (first === 198 && (second === 18 || second === 19)) return true;
	if (first === 198 && second === 51 && third === 100) return true;
	if (first === 203 && second === 0 && third === 113) return true;
	return first >= 224;
}

function expandIpv6(host: string): string[] | null {
	const [head, tail, extra] = host.toLowerCase().split("::");
	if (extra !== undefined) return null;
	const headParts = head ? head.split(":").filter(Boolean) : [];
	const tailParts = tail ? tail.split(":").filter(Boolean) : [];
	const missing = 8 - headParts.length - tailParts.length;
	if (missing < 0 || (tail === undefined && missing !== 0)) return null;
	const parts = [
		...headParts,
		...Array.from({ length: missing }, () => "0"),
		...tailParts,
	];
	if (
		parts.length !== 8 ||
		parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
	) {
		return null;
	}
	return parts.map((part) => part.padStart(4, "0"));
}

function isBlockedIpv6(host: string): boolean {
	const parts = expandIpv6(host);
	if (!parts) return true;
	if (parts.every((part) => part === "0000")) return true;
	if (
		parts.slice(0, 7).every((part) => part === "0000") &&
		parts[7] === "0001"
	) {
		return true;
	}
	if (
		parts.slice(0, 5).every((part) => part === "0000") &&
		parts[5] === "ffff"
	) {
		const high = Number.parseInt(parts[6] ?? "0", 16);
		const low = Number.parseInt(parts[7] ?? "0", 16);
		return isBlockedIpv4(
			`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
		);
	}
	if (parts.slice(0, 6).every((part) => part === "0000")) return true;
	const first = Number.parseInt(parts[0] ?? "0", 16);
	if ((first & 0xfe00) === 0xfc00) return true;
	if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) {
		return true;
	}
	if ((first & 0xff00) === 0xff00) return true;
	return parts[0] === "2001" && parts[1] === "0db8";
}

export function isPublicBoardRemoteAddress(value: string): boolean {
	const address = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (parseIpv4(address)) return !isBlockedIpv4(address);
	return address.includes(":") && !isBlockedIpv6(address);
}

function isBlockedHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal")
	) {
		return true;
	}
	if (parseIpv4(host) || host.includes(":")) {
		return !isPublicBoardRemoteAddress(host);
	}
	return false;
}

/**
 * Normalize a browser-loadable public HTTP(S) URL. This blocks explicit local
 * addresses; any future server-side fetcher must additionally validate DNS
 * resolution to defend against rebinding.
 */
export function normalizeBoardRemoteUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const input = value.trim();
	if (!input || input.length > BOARD_REMOTE_URL_MAX_LENGTH) return undefined;
	try {
		const url = new URL(input);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		if (url.username || url.password || isBlockedHost(url.hostname)) {
			return undefined;
		}
		const normalized = url.toString();
		return normalized.length <= BOARD_REMOTE_URL_MAX_LENGTH
			? normalized
			: undefined;
	} catch {
		return undefined;
	}
}

export const BoardRemoteUrlSchema = z
	.string()
	.max(BOARD_REMOTE_URL_MAX_LENGTH)
	.refine((value) => normalizeBoardRemoteUrl(value) !== undefined, {
		message: "URL must be a public HTTP(S) URL without credentials",
	});
