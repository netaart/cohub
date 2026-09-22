import { config } from "./config.js";
import { runGit } from "./checkpoint/git.js";

export const isGiteaMirrorEnabled = () => Boolean(config.giteaBaseUrl && config.giteaToken);

const configuredGitea = () => {
  if (!config.giteaBaseUrl || !config.giteaToken) {
    throw new Error("GITEA_BASE_URL and GITEA_TOKEN must be configured together");
  }
  return {
    baseUrl: config.giteaBaseUrl,
    token: config.giteaToken,
    org: config.giteaOrg,
  };
};

const createInternalRepository = async (name: string) => {
  const gitea = configuredGitea();
  const response = await fetch(`${gitea.baseUrl}/api/v1/orgs/${encodeURIComponent(gitea.org)}/repos`, {
    method: "POST",
    headers: {
      Authorization: `token ${gitea.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, private: true, auto_init: false }),
  });

  if (response.status === 409) return { name, alreadyExists: true };
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Gitea create internal repo error: ${response.status} ${text.replaceAll(gitea.token, "***")}`);
  }

  return response.json();
};

const buildInternalRepoRemoteUrl = (repoName: string) => {
  const gitea = configuredGitea();
  const base = new URL(gitea.baseUrl);
  base.username = "";
  base.password = "";
  base.search = "";
  base.hash = "";
  base.pathname = `/${gitea.org}/${repoName}.git`;
  return base.toString();
};

export const mirrorRepositoryToGitea = async (repoDir: string, repoName: string, branch: string) => {
  const gitea = configuredGitea();
  // Remove a remote left by older workers; never persist credentials again.
  await runGit(["remote", "remove", "cohub"], repoDir).catch(() => undefined);
  await createInternalRepository(repoName);
  const remoteUrl = buildInternalRepoRemoteUrl(repoName);
  const credentials = Buffer.from(`x-access-token:${gitea.token}`).toString("base64");
  await runGit([
    "--config-env=http.extraHeader=COHUB_GIT_AUTH_HEADER",
    "-c", "http.followRedirects=false",
    "-c", "credential.helper=",
    "push", "--", remoteUrl, branch,
  ], repoDir, {
    env: {
      COHUB_GIT_AUTH_HEADER: `Authorization: Basic ${credentials}`,
      GIT_TERMINAL_PROMPT: "0",
    },
    redact: [credentials, gitea.token],
  });
};
