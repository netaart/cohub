import { useLogto } from "@logto/rn";
import { useCallback } from "react";
import type { ProfileClaims } from "@/src/auth/profile-session.types";

export function useProfileSession() {
  const { client, signOut } = useLogto();
  const getClaims = useCallback(
    async () => await client.getIdTokenClaims() as ProfileClaims,
    [client],
  );
  return { getClaims, signOut };
}
