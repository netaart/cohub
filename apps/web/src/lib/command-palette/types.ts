import type {
	GlobalSearchType,
	GlobalSearchViewerRelation,
	LabelResourceType,
	SpacePublicProfile,
	UserProfile,
} from "@neta-art/cohub";

export type CommandPaletteItemType = GlobalSearchType | "command";
export type CommandPaletteResourceType = CommandPaletteItemType;
export type RemoteCommandPaletteResourceType = GlobalSearchType;
export type CommandPaletteItemSource =
	| "local"
	| "remote"
	| "local+remote"
	| "recent"
	| "default";

export type CommandPaletteViewerRelation =
	| GlobalSearchViewerRelation
	| "unknown";

export type CommandPaletteItem = {
	type: CommandPaletteItemType;
	id: string;
	spaceId: string;
	sessionId: string | null;
	turnId: string | null;
	sequence: number | null;
	title: string;
	excerpt: string | null;
	spaceName: string | null;
	ownerProfile?: Pick<
		UserProfile,
		"userUuid" | "displayName" | "avatarUrl"
	> | null;
	spaceProfile?: SpacePublicProfile | null;
	sessionTitle: string | null;
	matchedField:
		| "userText"
		| "title"
		| "name"
		| "description"
		| "command"
		| "labelName"
		| "labelItemContent";
	href: string;
	score: number;
	textScore: number;
	recencyScore: number;
	typePriorityScore: number;
	membershipPriorityScore?: number;
	labelRef?: string | null;
	labelName?: string | null;
	labelResourceType?: LabelResourceType | null;
	labelResourceRef?: string | null;
	viewerRelation?: CommandPaletteViewerRelation | null;
	/** Personal-relevance tier (0 = mine, 1 = space-related, 2 = public-only). */
	viewerTier?: number;
	updatedAt: string | null;
	source: CommandPaletteItemSource;
	isPinned?: boolean;
	isArchived?: boolean;
	localScore?: number;
	remoteScore?: number;
};

export type CommandPaletteSearchState = {
	items: CommandPaletteItem[];
	localDone: boolean;
	remoteDone: boolean;
	remoteError: string | null;
};
