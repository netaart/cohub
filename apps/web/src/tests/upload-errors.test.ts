import assert from "node:assert/strict";
import { test } from "node:test";
import {
	UPLOAD_ERROR_FILE_TOO_LARGE,
	UPLOAD_ERROR_RATE_LIMITED,
} from "@cohub/protocol";
import { formatByteLimit } from "#lib/format-bytes.ts";
import {
	describeUploadError,
	UploadTransferError,
} from "#lib/upload-errors.ts";

/** Same `code` / `body` shape the SDK's HttpError exposes for api rejections. */
const apiError = (body: Record<string, unknown>) =>
	Object.assign(new Error(String(body.message)), {
		code: body.code ?? null,
		body,
	});

test("formatByteLimit drops the decimal for whole units", () => {
	assert.equal(formatByteLimit(2 * 1024 ** 3), "2 GB");
	assert.equal(formatByteLimit(200 * 1024), "200 KB");
	assert.equal(formatByteLimit(1.5 * 1024 ** 3), "1.5 GB");
});

test("file_too_large maps to localized copy with the shared limit", () => {
	const error = apiError({
		code: UPLOAD_ERROR_FILE_TOO_LARGE,
		message: "file too large",
	});
	assert.equal(describeUploadError(error, "en"), "Files can't exceed 2 GB.");
	assert.equal(describeUploadError(error, "zh-CN"), "单个文件不能超过 2 GB。");
});

test("rate limits round the retry hint up to whole minutes", () => {
	const error = apiError({
		code: UPLOAD_ERROR_RATE_LIMITED,
		message: "too many uploads",
		retryAfterSeconds: 61,
	});
	assert.equal(
		describeUploadError(error, "zh-CN"),
		"上传过于频繁，请 2 分钟后重试。",
	);
	const noHint = apiError({
		code: UPLOAD_ERROR_RATE_LIMITED,
		message: "too many uploads",
	});
	assert.equal(
		describeUploadError(noHint, "en"),
		"Too many uploads. Try again shortly.",
	);
});

test("network drops are explained; other failures stay generic", () => {
	assert.equal(
		describeUploadError(new UploadTransferError(0), "en"),
		"Upload interrupted. Check your connection and retry.",
	);
	assert.equal(describeUploadError(new UploadTransferError(500), "en"), null);
	assert.equal(
		describeUploadError(apiError({ message: "space not found" }), "en"),
		null,
	);
	assert.equal(describeUploadError(new Error("boom"), "en"), null);
});
