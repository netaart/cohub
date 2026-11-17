import { PUBLIC_API_ORIGIN } from "$app/env/public";

export type UserProfile = {
	userUuid: string;
	username?: string | null;
	displayName: string;
	avatarUrl: string | null;
};

export type SpacePublicProfile = {
	avatarUrl: string | null;
};

export type TrendingRow = {
	rank: number;
	totalTokens: number;
	costTotal: number;
	sessionCount: number;
	requestCount: number;
};

export type SpaceRow = TrendingRow & {
	spaceId: string;
	spaceName: string;
	userId: string;
	userDisplay: string;
	userProfile: UserProfile;
	spaceProfile: SpacePublicProfile;
};

export type UserRow = TrendingRow & {
	userId: string;
	userDisplay: string;
	userProfile: UserProfile;
};

export type ModelRow = TrendingRow & {
	provider: string;
	model: string;
	modelDisplay: string;
};

/** Multimodal generation leaderboard row (no token totals). */
export type GenerationTrendingRow = {
	rank: number;
	costTotal: number;
	sessionCount: number;
	requestCount: number;
};

export type GenerationSpaceRow = GenerationTrendingRow & {
	spaceId: string;
	spaceName: string;
	userId: string;
	userDisplay: string;
	userProfile: UserProfile;
	spaceProfile: SpacePublicProfile;
};

export type GenerationUserRow = GenerationTrendingRow & {
	userId: string;
	userDisplay: string;
	userProfile: UserProfile;
};

export type GenerationModelRow = GenerationTrendingRow & {
	provider: string;
	model: string;
	modelDisplay: string;
};

function buildUrl(path: string) {
	const base = PUBLIC_API_ORIGIN ?? "";
	return `${base}/api/trending${path}`;
}

async function fetchJson<T>(path: string): Promise<T[]> {
	const res = await fetch(buildUrl(path));
	if (!res.ok) return [];
	return res.json();
}

export async function fetchSpaces(): Promise<SpaceRow[]> {
	return fetchJson<SpaceRow>("/spaces");
}

export async function fetchUsers(): Promise<UserRow[]> {
	return fetchJson<UserRow>("/users");
}

export async function fetchModels(): Promise<ModelRow[]> {
	return fetchJson<ModelRow>("/models");
}

export async function fetchGenerationSpaces(): Promise<GenerationSpaceRow[]> {
	return fetchJson<GenerationSpaceRow>("/generations/spaces");
}

export async function fetchGenerationUsers(): Promise<GenerationUserRow[]> {
	return fetchJson<GenerationUserRow>("/generations/users");
}

export async function fetchGenerationModels(): Promise<GenerationModelRow[]> {
	return fetchJson<GenerationModelRow>("/generations/models");
}
