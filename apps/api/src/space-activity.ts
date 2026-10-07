import type { SpaceRole } from "@cohub/db";
import {
	appViewStatsHourly,
	apps,
	generationUsageStatsHourly as generationUsage,
	spaceMembers,
	spaces,
	tokenUsageStatsHourly as tokenUsage,
} from "@cohub/db";
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { createLogger } from "@cohub/infra/logging";
import { db } from "./db/index.js";
import {
	aggregateUsage,
	aggregateUserModelRankings,
	buildUsageDateRange,
	resolveUsageDays,
	type GenerationUsageRow,
	type UsageAggregation,
	type UsageRow,
	type UserModelRankings,
} from "./usage-aggregation.js";
import {
	fallbackPublicUserProfile,
	getProfilesByUuids,
	type PublicUserProfile,
} from "./user-profiles.js";

const logger = createLogger({ serviceName: "cohub-api" });

export const touchSpaceActivity = async (spaceId: string, at = new Date()) => {
	await db.update(spaces).set({
		lastActivityAt: at,
	}).where(eq(spaces.id, spaceId));
};

const toFiniteNumber = (value: unknown): number => {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
};

const toIso = (value: Date | string | null) => {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export type SpaceActivityAppRanking = {
	appId: string;
	slug: string;
	title: string;
	status: "published" | "disabled";
	viewCount: number;
};

export type SpaceActivityContributor = {
	userUuid: string;
	role: SpaceRole | null;
	tokens: number;
	requests: number;
	costTotal: number;
	/** Distinct sessions with usage inside the selected range. */
	sessionCount: number;
	lastActiveAt: string | null;
	profile: PublicUserProfile | null;
};

export type SpaceActivityContributors = {
	items: SpaceActivityContributor[];
	/** Total space members — independent of the selected range. */
	memberCount: number;
};

export type SpaceActivityResponse = UsageAggregation & {
	days: number;
	rankings: UserModelRankings & {
		apps: SpaceActivityAppRanking[];
	};
	contributors: SpaceActivityContributors;
};

/**
 * Zero out cost figures for viewers without space-management access. The
 * response shape is preserved so clients can treat both variants uniformly.
 */
export function stripActivityCost(
	activity: SpaceActivityResponse,
): SpaceActivityResponse {
	return {
		...activity,
		hourly: activity.hourly.map((row) => ({
			...row,
			costInput: 0,
			costOutput: 0,
			costCacheRead: 0,
			costCacheWrite: 0,
			costTotal: 0,
		})),
		summary: {
			...activity.summary,
			costInput: 0,
			costOutput: 0,
			costCacheRead: 0,
			costCacheWrite: 0,
			costTotal: 0,
		},
		generation: {
			...activity.generation,
			hourly: activity.generation.hourly.map((row) => ({
				...row,
				costTotal: 0,
			})),
			summary: { ...activity.generation.summary, costTotal: 0 },
		},
		totals: { ...activity.totals, costTotal: 0 },
		rankings: {
			...activity.rankings,
			llmModels: activity.rankings.llmModels.map((row) => ({
				...row,
				costTotal: 0,
			})),
			generationModels: activity.rankings.generationModels.map((row) => ({
				...row,
				costTotal: 0,
			})),
		},
		contributors: {
			...activity.contributors,
			items: activity.contributors.items.map((row) => ({
				...row,
				costTotal: 0,
			})),
		},
	};
}

/** Keep contributor rows bounded no matter how large the space grows. */
export const MAX_CONTRIBUTORS = 50;
/** Mirror the /me/activity app ranking depth. */
const MAX_APP_RANKINGS = 5;
/** Generation rollup sentinel for work that has no session context. */
const GENERATION_USAGE_SESSION_NONE =
	"00000000-0000-4000-8000-000000000000";

type ContributorUsageRow = {
	userUuid: string;
	tokens: number;
	requests: number;
	costTotal: number;
	sessionCount: number;
	lastActiveAt: Date | string | null;
};

type SpaceAppRow = {
	id: string;
	slug: string;
	status: string;
	meta: unknown;
	viewCount: number;
};

/** postgres.js raw parameters must use serialized timestamp values. */
export function serializeActivityRange(startDate: Date, now: Date) {
	return {
		startAt: startDate.toISOString(),
		endAt: now.toISOString(),
	};
}

/**
 * Merge both usage domains before ranking. The aggregation happens in
 * PostgreSQL, so Node receives at most MAX_CONTRIBUTORS rows and never needs
 * to load a range's per-hour/per-session detail rows.
 */
function contributorUsageQuery(
	spaceId: string,
	startDate: Date,
	now: Date,
) {
	const { startAt, endAt } = serializeActivityRange(startDate, now);
	return db.execute<ContributorUsageRow>(sql`
		WITH contributor_usage AS (
			SELECT
				user_id AS user_uuid,
				total_tokens::double precision AS tokens,
				request_count::double precision AS requests,
				cost_total::double precision AS cost_total,
				session_id,
				bucket_start_at AS last_active_at
			FROM v2.token_usage_stats_hourly
			WHERE
				space_id = ${spaceId}::uuid
				AND bucket_start_at >= ${startAt}::timestamptz
				AND bucket_start_at <= ${endAt}::timestamptz
				AND user_id IS NOT NULL
				AND user_id <> 'unknown'

			UNION ALL

			SELECT
				user_id AS user_uuid,
				0::double precision AS tokens,
				request_count::double precision AS requests,
				cost_total::double precision AS cost_total,
				NULLIF(session_id, ${GENERATION_USAGE_SESSION_NONE}::uuid) AS session_id,
				bucket_start_at AS last_active_at
			FROM v2.generation_usage_stats_hourly
			WHERE
				space_id = ${spaceId}::uuid
				AND bucket_start_at >= ${startAt}::timestamptz
				AND bucket_start_at <= ${endAt}::timestamptz
				AND user_id IS NOT NULL
				AND user_id <> 'unknown'
		)
		SELECT
			user_uuid AS "userUuid",
			COALESCE(SUM(tokens), 0)::double precision AS tokens,
			COALESCE(SUM(requests), 0)::double precision AS requests,
			COALESCE(SUM(cost_total), 0)::double precision AS "costTotal",
			COUNT(DISTINCT session_id)::int AS "sessionCount",
			MAX(last_active_at) AS "lastActiveAt"
		FROM contributor_usage
		GROUP BY user_uuid
		ORDER BY
			SUM(tokens) DESC,
			SUM(requests) DESC,
			user_uuid ASC
		LIMIT ${MAX_CONTRIBUTORS}
	`);
}

/**
 * Rank apps by view count inside the range. Shared title resolution with
 * /me/activity's work ranking (meta.title > meta.name > meta.extracted.title).
 */
function rankSpaceApps(rows: SpaceAppRow[]): SpaceActivityAppRanking[] {
	return rows
		.map((row) => {
			const status: SpaceActivityAppRanking["status"] =
				row.status === "published" ? "published" : "disabled";
			return {
				appId: row.id,
				slug: row.slug,
				title: workTitle(row.meta, row.slug),
				status,
				viewCount: toFiniteNumber(row.viewCount),
			};
		})
		.sort((a, b) => b.viewCount - a.viewCount)
		.slice(0, MAX_APP_RANKINGS);
}

function workTitle(meta: unknown, slug: string): string {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return slug;
	const value = meta as Record<string, unknown>;
	const extracted =
		value.extracted && typeof value.extracted === "object" && !Array.isArray(value.extracted)
			? (value.extracted as Record<string, unknown>)
			: null;
	for (const candidate of [value.title, value.name, extracted?.title]) {
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return slug;
}

/**
 * Load everything the space Activity page renders. Hourly data is grouped in
 * PostgreSQL by its reporting dimensions before it reaches Node. The shared
 * reducers then preserve the existing response semantics and model lists.
 */
export async function loadSpaceActivity(input: {
	spaceId: string;
	daysParam: string | undefined;
}): Promise<SpaceActivityResponse> {
	const days = resolveUsageDays(input.daysParam);
	const { startDate, now } = buildUsageDateRange(days);

	let usageRows: UsageRow[];
	let generationRows: GenerationUsageRow[];
	let memberRows: { userId: string; role: SpaceRole }[];
	let appRows: SpaceAppRow[];
	let contributorRows: ContributorUsageRow[];
	try {
		[usageRows, generationRows, memberRows, appRows, contributorRows] =
			await Promise.all([
				db
					.select({
						bucketStartAt: tokenUsage.bucketStartAt,
						totalTokens: sql<number>`coalesce(sum(${tokenUsage.totalTokens}), 0)::double precision`,
						inputTokens: sql<number>`coalesce(sum(${tokenUsage.inputTokens}), 0)::double precision`,
						outputTokens: sql<number>`coalesce(sum(${tokenUsage.outputTokens}), 0)::double precision`,
						cacheReadTokens: sql<number>`coalesce(sum(${tokenUsage.cacheReadTokens}), 0)::double precision`,
						cacheWriteTokens: sql<number>`coalesce(sum(${tokenUsage.cacheWriteTokens}), 0)::double precision`,
						costInput: sql<string>`coalesce(sum(${tokenUsage.costInput}), 0)::text`,
						costOutput: sql<string>`coalesce(sum(${tokenUsage.costOutput}), 0)::text`,
						costCacheRead: sql<string>`coalesce(sum(${tokenUsage.costCacheRead}), 0)::text`,
						costCacheWrite: sql<string>`coalesce(sum(${tokenUsage.costCacheWrite}), 0)::text`,
						costTotal: sql<string>`coalesce(sum(${tokenUsage.costTotal}), 0)::text`,
						requestCount: sql<number>`coalesce(sum(${tokenUsage.requestCount}), 0)::double precision`,
						successCount: sql<number>`coalesce(sum(${tokenUsage.successCount}), 0)::double precision`,
						errorCount: sql<number>`coalesce(sum(${tokenUsage.errorCount}), 0)::double precision`,
						provider: tokenUsage.provider,
						model: tokenUsage.model,
					})
					.from(tokenUsage)
					.where(
						and(
							eq(tokenUsage.spaceId, input.spaceId),
							gte(tokenUsage.bucketStartAt, startDate),
							lte(tokenUsage.bucketStartAt, now),
						),
					)
					.groupBy(
						tokenUsage.bucketStartAt,
						tokenUsage.provider,
						tokenUsage.model,
					)
					.orderBy(
						asc(tokenUsage.bucketStartAt),
						asc(tokenUsage.provider),
						asc(tokenUsage.model),
					),
				db
					.select({
						bucketStartAt: generationUsage.bucketStartAt,
						costTotal: sql<string>`coalesce(sum(${generationUsage.costTotal}), 0)::text`,
						requestCount: sql<number>`coalesce(sum(${generationUsage.requestCount}), 0)::double precision`,
						successCount: sql<number>`coalesce(sum(${generationUsage.successCount}), 0)::double precision`,
						errorCount: sql<number>`coalesce(sum(${generationUsage.errorCount}), 0)::double precision`,
						provider: generationUsage.provider,
						model: generationUsage.model,
						usageType: generationUsage.usageType,
					})
					.from(generationUsage)
					.where(
						and(
							eq(generationUsage.spaceId, input.spaceId),
							gte(generationUsage.bucketStartAt, startDate),
							lte(generationUsage.bucketStartAt, now),
						),
					)
					.groupBy(
						generationUsage.bucketStartAt,
						generationUsage.provider,
						generationUsage.model,
						generationUsage.usageType,
					)
					.orderBy(
						asc(generationUsage.bucketStartAt),
						asc(generationUsage.provider),
						asc(generationUsage.model),
						asc(generationUsage.usageType),
					),
				db
					.select({ userId: spaceMembers.userId, role: spaceMembers.role })
					.from(spaceMembers)
					.where(eq(spaceMembers.spaceId, input.spaceId)),
				db
					.select({
						id: apps.id,
						slug: apps.slug,
						status: apps.status,
						meta: apps.meta,
						viewCount: sql<number>`coalesce(sum(${appViewStatsHourly.viewCount}), 0)`,
					})
					.from(apps)
					.leftJoin(
						appViewStatsHourly,
						and(
							eq(appViewStatsHourly.appId, apps.id),
							gte(appViewStatsHourly.bucketStartAt, startDate),
							lt(appViewStatsHourly.bucketStartAt, new Date(now.getTime() + 1)),
						),
					)
					.where(eq(apps.spaceId, input.spaceId))
					.groupBy(apps.id, apps.slug, apps.status, apps.meta)
					.orderBy(desc(sql`coalesce(sum(${appViewStatsHourly.viewCount}), 0)`))
					.limit(MAX_APP_RANKINGS),
				contributorUsageQuery(input.spaceId, startDate, now),
			]);
	} catch (error) {
		logger.error("[space-activity] DB query failed", error);
		throw error;
	}

	const usage = aggregateUsage(usageRows, generationRows);
	const modelRankings = aggregateUserModelRankings(usageRows, generationRows);

	// Profiles load only for the contributors actually returned (≤50 rows).
	const contributorUuids = contributorRows.map((row) => row.userUuid);
	const profiles = contributorUuids.length
		? await getProfilesByUuids(contributorUuids)
		: new Map<string, PublicUserProfile>();
	const profileOf = (userId: string) =>
		profiles.get(userId) ?? fallbackPublicUserProfile(userId);

	// Roles join in memory: the member projection is tiny compared with usage.
	const rolesByUser = new Map(
		memberRows.map((row) => [row.userId, row.role] as const),
	);
	const contributors: SpaceActivityContributor[] = contributorRows
		.slice(0, MAX_CONTRIBUTORS)
		.map((row) => ({
		userUuid: row.userUuid,
		role: rolesByUser.get(row.userUuid) ?? null,
		tokens: toFiniteNumber(row.tokens),
		requests: toFiniteNumber(row.requests),
		costTotal: toFiniteNumber(row.costTotal),
		sessionCount: toFiniteNumber(row.sessionCount),
		lastActiveAt: toIso(row.lastActiveAt),
		profile: profileOf(row.userUuid),
		}));

	return {
		...usage,
		days,
		rankings: {
			llmModels: modelRankings.llmModels,
			generationModels: modelRankings.generationModels,
			apps: rankSpaceApps(appRows),
		},
		contributors: {
			items: contributors,
			memberCount: memberRows.length,
		},
	};
}
