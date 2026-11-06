export const spaceWalletCustomerId = (spaceId: string) => `cohub:space-wallet:${spaceId}`;

export function walletActorReason(userId: string, reason: string | undefined): string {
  const actorPrefix = `actor_user_id=${encodeURIComponent(userId)}; `;
  return actorPrefix + (reason ?? "").slice(0, Math.max(0, 1024 - actorPrefix.length));
}
