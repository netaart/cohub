export type ProfileClaims = Record<string, unknown> & {
  name?: string;
  username?: string;
  email?: string;
  picture?: string;
};
