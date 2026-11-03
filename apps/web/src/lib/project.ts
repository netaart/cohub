export const REPO_URL = "https://github.com/netaart/cohub";
export const LICENSE = "Apache-2.0";
export const CLI_NPM_URL = "https://www.npmjs.com/package/@neta-art/cohub-cli";

export const repoFileUrl = (path: string) => `${REPO_URL}/blob/main/${path}`;

const { release, commit } = __COHUB_BUILD__;

export const RELEASE = release;

export const BUILD_LABEL =
	[release, commit].filter(Boolean).join(" · ") || "dev";
