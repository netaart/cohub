export const COHUB_BILLING_POLICY = {
  hardNegativeLimitUsd: 0,
  minimumBalanceUsdByUsageKind: {
    "generation.video": 1.01,
  },
  failClosedUsageKinds: ["generation.video"],
} as const;
