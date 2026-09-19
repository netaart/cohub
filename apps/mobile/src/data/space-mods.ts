import type { CohubClient, SpaceModListItem } from "@neta-art/cohub";

export async function installSpaceMod(client: CohubClient, spaceId: string, input: string): Promise<{ item: SpaceModListItem; sandboxRestarting: boolean }> {
  const modSpaceId = input.trim();
  if (!spaceId.trim()) throw new Error("A target Space is required.");
  if (!modSpaceId) throw new Error("Enter the Mod Space ID.");
  return client.space(spaceId).mods.create({ modSpaceId });
}
