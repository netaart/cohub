import { useEffect, useState } from "react";
import { useProfileSession } from "@/src/auth/profile-session";
import type { ProfileClaims } from "@/src/auth/profile-session.types";
import { translate } from "@/src/i18n/core";

export type CurrentUser = {
  name: string;
  email: string | null;
  avatar: string | null;
};

function fallbackUser(): CurrentUser {
  return { name: translate("settings.profile.fallbackName"), email: null, avatar: null };
}

function userFromClaims(claims: ProfileClaims): CurrentUser {
  const name = typeof claims.name === "string" && claims.name.trim()
    ? claims.name.trim()
    : typeof claims.username === "string" && claims.username.trim()
      ? claims.username.trim()
      : fallbackUser().name;
  return {
    name,
    email: typeof claims.email === "string" ? claims.email : null,
    avatar: typeof claims.picture === "string" ? claims.picture : null,
  };
}

/** Reads the signed-in identity from the ID token claims; falls back to a neutral placeholder. */
export function useCurrentUser(): CurrentUser {
  const { getClaims } = useProfileSession();
  const [user, setUser] = useState<CurrentUser>(fallbackUser);

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
