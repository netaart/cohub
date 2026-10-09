import type {
	SpaceActivityAppRanking,
	SpaceActivityContributor,
	SpaceActivityResponse,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import {
	error,
	handleHttp,
	json as outJson,
	jsonRequested,
	table,
	type Row,
} from "../output.js";
import { resolveSpace } from "../space.js";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export type SpaceActivityCliOptions = {
	json?: boolean;
};

type SpaceActivityCommandClient = {
	space(spaceId: string): {
		activity: {
			get(days: number): Promise<SpaceActivityResponse>;
		};
	};
};

export class InvalidSpaceActivityDaysError extends Error {
	constructor(
		message: string,
		readonly detail: string,
	) {
		super(message);
		this.name = "InvalidSpaceActivityDaysError";
	}
}

/** Shared with the API: any positive day count up to a full leap year. */
export function parseActivityDays(value: string | undefined): number {
	const raw = (value ?? String(DEFAULT_DAYS)).trim();
	if (!/^\d+$/.test(raw)) {
		throw new InvalidSpaceActivityDaysError(
			"Invalid days",
			"days must be a positive integer",
		);
	}
	const days = Number.parseInt(raw, 10);
	if (days < 1 || days > MAX_DAYS) {
		throw new InvalidSpaceActivityDaysError(
			"Invalid days",
			`days must be between 1 and ${MAX_DAYS}`,
		);
	}
	return days;
}

const formatNumber = (value: unknown): string =>
	new Intl.NumberFormat("en-US").format(Number(value) || 0);

const formatCost = (value: unknown): string =>
	`$${(Number(value) || 0).toFixed(2)}`;

function relativeTime(timestamp: string | null): string {
	if (!timestamp) return "";
	const at = new Date(timestamp).getTime();
	if (!Number.isFinite(at)) return "";
	const deltaMs = Date.now() - at;
	const minutes = Math.round(deltaMs / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

export function toContributorRows(items: SpaceActivityContributor[]): Row[] {
	return items.map((contributor) => ({
		name:
			contributor.profile?.displayName ||
			contributor.profile?.username ||
			contributor.userUuid,
		role: contributor.role ?? "",
		tokens: formatNumber(contributor.tokens),
		requests: formatNumber(contributor.requests),
		sessions: contributor.sessionCount,
		cost: formatCost(contributor.costTotal),
		lastActive: relativeTime(contributor.lastActiveAt),
	}));
}

export function toAppRankingRows(apps: SpaceActivityAppRanking[]): Row[] {
	return apps.map((app) => ({
		title: app.title,
		status: app.status,
		views: formatNumber(app.viewCount),
		id: app.appId,
	}));
}

export function printActivityReport(activity: SpaceActivityResponse): void {
	const { totals } = activity;
	const showCost = totals.costTotal !== 0;

	console.log(`\n  Summary (last ${activity.days} days):`);
	table([totals], [
		{ key: "totalTokens", label: "Tokens", format: formatNumber },
		{ key: "requestCount", label: "Requests", format: formatNumber },
		...(showCost ? [{ key: "costTotal", label: "Cost", format: formatCost }] : []),
		{ key: "successCount", label: "Success", format: formatNumber },
		{ key: "errorCount", label: "Errors", format: formatNumber },
	]);

	if (activity.contributors.items.length > 0) {
		console.log(`\n  Contributors (${activity.contributors.memberCount} members):`);
		table(toContributorRows(activity.contributors.items), [
			{ key: "name", label: "Name" },
			{ key: "role", label: "Role" },
			{ key: "tokens", label: "Tokens" },
			{ key: "requests", label: "Requests" },
			{ key: "sessions", label: "Sessions" },
			...(showCost ? [{ key: "cost", label: "Cost" }] : []),
			{ key: "lastActive", label: "Last active" },
		]);
	}

	const { llmModels, generationModels, apps } = activity.rankings;
	if (llmModels.length > 0) {
		console.log("\n  Top LLM models:");
		table(llmModels, [
			{ key: "model", label: "Model" },
			{ key: "provider", label: "Provider" },
			{ key: "totalTokens", label: "Tokens", format: formatNumber },
			{ key: "requestCount", label: "Requests", format: formatNumber },
			...(showCost ? [{ key: "costTotal", label: "Cost", format: formatCost }] : []),
		]);
	}
	if (generationModels.length > 0) {
		console.log("\n  Top generation models:");
		table(generationModels, [
			{ key: "model", label: "Model" },
			{ key: "provider", label: "Provider" },
			{ key: "requestCount", label: "Calls", format: formatNumber },
			...(showCost ? [{ key: "costTotal", label: "Cost", format: formatCost }] : []),
		]);
	}
	if (apps.length > 0) {
		console.log("\n  Most viewed apps:");
		table(toAppRankingRows(apps), [
			{ key: "title", label: "App" },
			{ key: "views", label: "Views" },
			{ key: "status", label: "Status" },
			{ key: "id", label: "ID" },
		]);
	}
}

export function registerSpaceActivity(
	spacesCmd: Command,
	dependencies: { createClient?: () => SpaceActivityCommandClient } = {},
): void {
	spacesCmd
		.command("activity [days]")
		.description("Space activity overview: usage, contributors, rankings")
		.option("--json", "Output as JSON")
		.action(async (days: string | undefined, opts: SpaceActivityCliOptions) => {
			const spaceId = await resolveSpace(spacesCmd);
			let parsedDays: number;
			try {
				parsedDays = parseActivityDays(days);
			} catch (cause) {
				if (cause instanceof InvalidSpaceActivityDaysError) {
					return error(cause.message, cause.detail);
				}
				throw cause;
			}

			const client = dependencies.createClient?.() ?? createClient();
			try {
				const activity = await client.space(spaceId).activity.get(parsedDays);
				if (jsonRequested(opts)) return outJson(activity);
				printActivityReport(activity);
			} catch (cause) {
				handleHttp(cause);
			}
		});
}
