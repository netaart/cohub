import {
	APP_BROWSER_SESSION_HINT,
	APP_BROWSER_SESSION_PATH,
	APP_BROWSER_SESSION_SECONDS,
	appReturnPath,
	isUuid,
} from "@cohub/protocol";

const cookiePrefix = "__Host-cohub-app-";
const sessionCookie = cookiePrefix + "session";
const proofCookie = (challenge: string) => cookiePrefix + "proof-" + challenge;
export const isAppBrowserCookie = (pair: string) =>
	pair.trimStart().toLowerCase().startsWith(cookiePrefix.toLowerCase());

function cookie(request: Request, name: string) {
	return request.headers
		.get("cookie")
		?.split(";")
		.map((pair) => pair.trim())
		.find((pair) => pair.startsWith(name + "="))
		?.slice(name.length + 1);
}

const setCookie = (name: string, value: string, seconds: number) =>
	`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;

function base64url(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

export async function serveAppBrowserSession(input: {
	request: Request;
	url: URL;
	apiOrigin: string;
	fetcher: typeof fetch;
}): Promise<Response> {
	const { request, url } = input;
	const headers = new Headers({
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	});
	const respond = (status: number) => new Response(null, { status, headers });
	const appId = url.searchParams.get("app");
	if (!isUuid(appId) || url.protocol !== "https:") return respond(400);
	const action = url.pathname.slice(APP_BROWSER_SESSION_PATH.length + 1);
	if (action === "callback") {
		if (request.method !== "GET") return respond(405);
	} else if (
		request.method !== "POST" ||
		request.headers.get("origin") !== url.origin
	) {
		return respond(403);
	}

	if (action === "start") {
		const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = base64url(
			new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(verifier),
				),
			),
		);
		headers.append(
			"Set-Cookie",
			setCookie(proofCookie(challenge), verifier, 600),
		);
		return Response.json({ challenge }, { headers });
	}

	const call = (method: string, body: Record<string, string>) =>
		input.fetcher(
			`${input.apiOrigin}/api/apps/${appId}/browser-session/${method}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				cache: "no-store",
				redirect: "error",
				body: JSON.stringify({ ...body, origin: url.origin }),
			},
		);

	if (action === "callback") {
		const challenge = url.searchParams.get("challenge") ?? "";
		const code = url.searchParams.get("code") ?? "";
		if (!/^[\w-]{43}$/.test(challenge) || !/^[\w-]{43}$/.test(code))
			return respond(400);
		const verifier = cookie(request, proofCookie(challenge));
		const result = verifier ? await call("exchange", { verifier, code }) : null;
		if (!result?.ok) {
			const retryPath = appReturnPath(
				url.searchParams.get("returnTo") ?? "",
				url.origin,
			);
			if (
				!retryPath ||
				(result && result.status !== 401 && result.status !== 403)
			)
				return respond(result?.status ?? 401);
			headers.set("Location", new URL(retryPath, url.origin).href);
			return respond(303);
		}
		const { session, returnTo } = (await result.json()) as {
			session: string;
			returnTo: string;
		};
		const path = appReturnPath(returnTo, url.origin);
		if (!path || !/^[\w-]{43}$/.test(session)) return respond(502);
		headers.append("Set-Cookie", setCookie(proofCookie(challenge), "", 0));
		headers.append(
			"Set-Cookie",
			setCookie(
				sessionCookie,
				appId + "." + session,
				APP_BROWSER_SESSION_SECONDS,
			),
		);
		headers.append(
			"Set-Cookie",
			`${APP_BROWSER_SESSION_HINT}=${appId}.${challenge}; Path=/; Secure; SameSite=Lax; Max-Age=${APP_BROWSER_SESSION_SECONDS}`,
		);
		headers.set("Location", new URL(path, url.origin).href);
		return respond(303);
	}

	if (action !== "token" && action !== "logout") return respond(404);
	const handle = cookie(request, sessionCookie);
	if (!handle?.startsWith(appId + ".")) return respond(204);
	const result = await call(action, {
		session: handle.slice(appId.length + 1),
	});
	if (
		(action === "logout" && result.ok) ||
		result.status === 401 ||
		result.status === 403
	) {
		headers.append("Set-Cookie", setCookie(sessionCookie, "", 0));
		headers.append("Set-Cookie", setCookie(APP_BROWSER_SESSION_HINT, "", 0));
		return respond(204);
	}
	if (!result.ok) return respond(result.status);
	return Response.json(await result.json(), { headers });
}
