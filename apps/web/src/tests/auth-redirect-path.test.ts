import assert from "node:assert/strict";
import { it } from "node:test";
import { sanitizeRedirectPath } from "#lib/auth-redirect-path.ts";

it("preserves the validated broker return through the Cohub OAuth callback", () => {
	const broker =
		"/app-auth?app=11111111-1111-4111-8111-111111111111&origin=https%3A%2F%2Fshop.example";
	assert.equal(sanitizeRedirectPath(broker), broker);
	for (const invalid of [
		"/callback?redirect_path=/shop",
		"//shop.example/path",
		"/app-auth",
		broker.replace("https%3A", "file%3A"),
	]) {
		assert.equal(sanitizeRedirectPath(invalid), "/");
	}
});
