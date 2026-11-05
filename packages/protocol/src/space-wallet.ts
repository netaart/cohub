export type SpaceWalletSummary = {
  spaceId: string;
  balanceUsd: number;
  usable: boolean;
};

export type SpaceWalletActivity = {
  id: string;
  kind: "grant" | "usage" | "reversal" | "refund" | "expire" | "revoke" | "adjust";
  title: string;
  generationPhase: "reserve" | "settlement" | "refund" | null;
  amountUsd: number;
  actorUserId: string | null;
  sourceId: string | null;
  createdAt: string;
};

export type SpaceWalletActivityPage = {
  items: SpaceWalletActivity[];
  hasMore: boolean;
};
