import { useEffect, useState } from "react";
import { useProfileSession } from "@/src/auth/profile-session";
import type { ProfileClaims } from "@/src/auth/profile-session.types";

export type CurrentUser = {
  name: string;
  email: string | null;
  avatar: string | null;
};

const FALLBACK_USER: CurrentUser = { name: "Cohub user", email: null, avatar: null };

function userFromClaims(claims: ProfileClaims): CurrentUser {
  const name = typeof claims.name === "string" && claims.name.trim()
    ? claims.name.trim()
    : typeof claims.username === "string" && claims.username.trim()
      ? claims.username.trim()
      : FALLBACK_USER.name;
  return {
    name,
    email: typeof claims.email === "string" ? claims.email : null,
    avatar: typeof claims.picture === "string" ? claims.picture : null,
  };
}

/** Reads the signed-in identity from the ID token claims; falls back to a neutral placeholder. */
export function useCurrentUser(): CurrentUser {
  const { getClaims } = useProfileSession();
  const [user, setUser] = useState<CurrentUser>(FALLBACK_USER);

  useEffect(() => {
    let active = true;
    void getClaims()
      .then((claims) => {
        if (active) setUser(userFromClaims(claims));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [getClaims]);

  return user;
}
