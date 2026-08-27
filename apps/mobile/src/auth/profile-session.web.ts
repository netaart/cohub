import type { ProfileClaims } from "@/src/auth/profile-session.types";

const previewClaims: ProfileClaims = {
  name: "Cohub Mobile",
  email: "Web preview",
};

const getClaims = async () => previewClaims;
const signOut = async () => undefined;

export function useProfileSession() {
  return { getClaims, signOut };
}
