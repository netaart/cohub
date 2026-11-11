export type SpaceWalletSummary = {
  spaceId: string;
  balanceUsd: number;
  usable: boolean;
};

export type SpaceWalletActivity = {
  id: string;
  kind: "grant" | "usage" | "reversal" | "refund" | "expire" | "revoke" | "adjust";
  title: string;
  amountUsd: number;
  actorUserId: string | null;
  sourceId: string | null;
  createdAt: string;
};

export type SpaceWalletActivityPage = {
  items: SpaceWalletActivity[];
  nextCursor: string | null;
};

export const SPACE_WALLET_TRANSFER_MIN_USD = 1;
export const SPACE_WALLET_TRANSFER_MAX_USD = 5_000;
export const SPACE_WALLET_UPDATED_EVENT = "space.wallet.updated";
export const SPACE_WALLET_TRANSFER_RECOVER_JOB = "space_wallet.transfer.recover";
export const SPACE_WALLET_TRANSFER_RECOVER_ATTEMPTS = 9;
export const SPACE_WALLET_TRANSFER_CREDIT_ATTEMPTS = 6;

export type SpaceWalletFundingTier = {
  productKey: string;
  amountUsd: number;
  priceUsd: number;
};

export type SpaceWalletFunding = {
  space: { id: string; name: string; avatarUrl: string | null; description: string | null };
  publicFunding: boolean;
  checkout: boolean;
  tiers: SpaceWalletFundingTier[];
  transfer: { allowanceUsd: number; minUsd: number; maxUsd: number } | null;
};

export type SpaceWalletTransferState = "none" | "processing" | "completed" | "refunded";

export type SpaceWalletTransferStatus = {
  id: string;
  state: SpaceWalletTransferState;
  amountUsd: number;
  creditedUsd: number;
  refundedUsd: number;
};

export type SpaceWalletTransferRecoverJobData = {
  id: string;
  spaceId: string;
  spaceName: string;
  userId: string;
  actorName: string;
  trace?: Record<string, unknown>;
};
